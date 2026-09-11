import { ref, readonly } from 'vue'
import { getBaseUrl, getMockMode } from '../api/client'
import { useRobotsStore } from '../stores/robots'

/**
 * WebSocket-клиент телеметрии роботов.
 *
 * Формат VDA5050 (согласовано с Семёном 2026-09-11):
 *
 * 1) Позиция для Live Map (частое, ~5-10Hz):
 *    {
 *      robot_id: "ktc-23",
 *      agvPosition: { mapId, positionInitialized, theta, x, y },
 *      headerId, manufacturer, serialNumber, timestamp, version
 *    }
 *
 * 2) Полный state для таблицы Robots (реже):
 *    {
 *      robot_id: "ktc-23",
 *      agvPosition: {...},
 *      batteryState: { batteryCharge, charging },
 *      driving: bool,
 *      operatingMode: "AUTOMATIC" | "MANUAL" | "SEMIAUTOMATIC" | "SERVICE",
 *      safetyState: { eStop, fieldViolation },
 *      errors: [...],
 *      manufacturer, serialNumber, timestamp, version, ...
 *    }
 *
 * Различаем по наличию batteryState — если есть, это полный state.
 *
 * URL:
 *   - runtime config `window.__FLEET_CONFIG__.wsUrl` в приоритете (если задан)
 *   - иначе derive из apiBaseUrl: http(s)://host/api → ws(s)://host
 *
 * Автопереподключение с экспоненциальным backoff (1с → 2 → 5 → 10 → 30 max).
 * В mock-режиме WS не подключается — телеметрию имитировать некому.
 *
 * Использование: один инстанс на всё приложение, connect() из App.vue.onMounted.
 */

/**
 * Правила маппинга статуса из VDA5050-полей полного state (согласовано с Семёном 2026-09-11):
 *   1. errors[] не пусто            → 'error'
 *   2. safetyState.eStop != 'NONE'  → 'error'
 *   3. batteryState.charging        → 'charging'
 *   4. driving                      → 'moving'
 *   5. operatingMode == SEMIAUTOMATIC / MANUAL → 'teleop'
 *   6. иначе                        → 'idle'
 */
function deriveStatus(state) {
  if (Array.isArray(state.errors) && state.errors.length) return 'error'
  const eStop = state.safetyState?.eStop
  if (eStop && eStop !== 'NONE') return 'error'
  if (state.batteryState?.charging) return 'charging'
  if (state.driving) return 'moving'
  const opMode = String(state.operatingMode || '').toUpperCase()
  if (opMode === 'SEMIAUTOMATIC' || opMode === 'MANUAL') return 'teleop'
  return 'idle'
}

function robotIdOf(msg) {
  if (msg.robot_id) return String(msg.robot_id)
  // На случай если robot_id не пришлют — собираем из manufacturer + serialNumber.
  if (msg.manufacturer && msg.serialNumber) return `${msg.manufacturer}-${msg.serialNumber}`
  return null
}

function deriveWsUrl() {
  const rt = (typeof window !== 'undefined' && window.__FLEET_CONFIG__?.wsUrl) || ''
  if (rt && String(rt).trim()) return String(rt).trim()

  const base = getBaseUrl()
  try {
    const u = new URL(base, window.location.origin)
    const wsProto = u.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${wsProto}//${u.host}`
  } catch {
    return null
  }
}

const state = ref('idle')  // 'idle' | 'connecting' | 'open' | 'closed' | 'error'
const lastMessageAt = ref(null)
const lastError = ref(null)
let ws = null
let reconnectTimer = null
let reconnectAttempt = 0
let stopping = false

function scheduleReconnect() {
  if (stopping) return
  if (reconnectTimer) return
  const backoff = [1000, 2000, 5000, 10000, 30000]
  const wait = backoff[Math.min(reconnectAttempt, backoff.length - 1)]
  reconnectAttempt++
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, wait)
}

function handleMessage(raw) {
  lastMessageAt.value = new Date()
  let msg
  try { msg = JSON.parse(raw) } catch { return }
  if (!msg || typeof msg !== 'object') return

  const robotId = robotIdOf(msg)
  if (!robotId) return

  const store = useRobotsStore()

  // Полный state — есть batteryState/driving/operatingMode. Обновляем всё.
  if (msg.batteryState || 'driving' in msg || msg.operatingMode) {
    const patch = { status: deriveStatus(msg) }
    if (msg.batteryState && msg.batteryState.batteryCharge != null) {
      patch.battery = Math.round(Number(msg.batteryState.batteryCharge))
    }
    if (msg.agvPosition) {
      patch.x = Number(msg.agvPosition.x) || 0
      patch.y = Number(msg.agvPosition.y) || 0
      patch.theta = Number(msg.agvPosition.theta) || 0
      patch.positionInitialized = !!msg.agvPosition.positionInitialized
    }
    store.applyTelemetry(robotId, patch)
    return
  }

  // Позиция для Live Map — только agvPosition.
  if (msg.agvPosition) {
    store.applyTelemetry(robotId, {
      x: Number(msg.agvPosition.x) || 0,
      y: Number(msg.agvPosition.y) || 0,
      theta: Number(msg.agvPosition.theta) || 0,
      positionInitialized: !!msg.agvPosition.positionInitialized,
    })
  }
}

export function connect() {
  if (getMockMode()) { state.value = 'idle'; return }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
  const url = deriveWsUrl()
  if (!url) { state.value = 'error'; lastError.value = 'Cannot derive WS URL'; return }

  stopping = false
  state.value = 'connecting'
  try {
    ws = new WebSocket(url)
  } catch (e) {
    state.value = 'error'
    lastError.value = e.message
    scheduleReconnect()
    return
  }

  ws.onopen = () => {
    state.value = 'open'
    lastError.value = null
    reconnectAttempt = 0
  }
  ws.onmessage = (ev) => handleMessage(ev.data)
  ws.onerror = () => {
    state.value = 'error'
    lastError.value = 'WebSocket error'
  }
  ws.onclose = () => {
    state.value = 'closed'
    if (!stopping) scheduleReconnect()
  }
}

export function disconnect() {
  stopping = true
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  if (ws) {
    try { ws.close() } catch { /* ignore */ }
    ws = null
  }
  state.value = 'idle'
}

export function useTelemetryWs() {
  return {
    state: readonly(state),
    lastMessageAt: readonly(lastMessageAt),
    lastError: readonly(lastError),
    connect,
    disconnect,
  }
}
