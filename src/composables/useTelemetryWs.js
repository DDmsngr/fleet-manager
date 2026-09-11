import { ref, readonly } from 'vue'
import { getBaseUrl, getMockMode } from '../api/client'
import { useRobotsStore } from '../stores/robots'

/**
 * WebSocket-клиент телеметрии роботов.
 *
 * Формат VDA5050 (согласовано с Семёном 2026-09-11):
 * По WS робот шлёт ТОЛЬКО agvPosition. State (battery/status/errors/driving)
 * приходит через HTTP GET /fms/robots (polling каждые 5с).
 *
 * Сообщение:
 *   {
 *     robot_id: "ktc-23",
 *     agvPosition: { mapId, positionInitialized, theta, x, y },
 *     headerId, manufacturer, serialNumber, timestamp, version
 *   }
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
  if (!msg || typeof msg !== 'object' || !msg.agvPosition) return

  const robotId = robotIdOf(msg)
  if (!robotId) return

  const store = useRobotsStore()
  store.applyTelemetry(robotId, {
    x: Number(msg.agvPosition.x) || 0,
    y: Number(msg.agvPosition.y) || 0,
    theta: Number(msg.agvPosition.theta) || 0,
    positionInitialized: !!msg.agvPosition.positionInitialized,
    // mapId — VDA5050-идентификатор карты, к которой привязана позиция.
    // Используется для фильтрации на Live Map: показываем только тех роботов,
    // чей mapId совпадает с активной картой.
    mapId: msg.agvPosition.mapId || null,
  })
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
