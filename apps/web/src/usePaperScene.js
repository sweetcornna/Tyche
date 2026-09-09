import { useEffect, useRef, useState } from 'react'
import { controlApi, isSessionFailure } from './api.js'
import { advancePaperScene, paperPollDelay } from './paper-scene.js'

export function usePaperScene(csrf, running, onSessionFailure) {
  const [view, setView] = useState({ scene: null, events: [], notice: '' })
  const runningRef = useRef(running)
  const wakeRef = useRef(null)
  runningRef.current = running
  useEffect(() => {
    setView({ scene: null, events: [], notice: '' })
    if (!csrf) return undefined
    let alive = true, serial = 0, timer, controller, cursor = null, current = null, baseline = true
    const poll = async () => {
      window.clearTimeout(timer)
      if (!alive || document.hidden) return
      const requestId = ++serial
      controller?.abort()
      controller = new AbortController()
      try {
        const snapshot = await controlApi.paperScene(csrf, controller.signal)
        if (!alive || requestId !== serial) return
        const result = advancePaperScene(cursor, snapshot, baseline)
        if (result.accepted) {
          cursor = result.cursor
          baseline = snapshot.status !== 'ready'
          if (snapshot.status === 'ready') current = snapshot
          setView({ scene: snapshot.status === 'ready' ? snapshot : { ...snapshot, previous: current }, events: result.events, notice: result.notice })
        }
      } catch (error) {
        if (!alive || requestId !== serial || error.name === 'AbortError') return
        baseline = true
        if (isSessionFailure(error)) {
          alive = false
          setView({ scene: null, events: [], notice: '' })
          onSessionFailure(error, csrf)
          return
        }
        setView({ scene: { status: 'unavailable', previous: current }, events: [], notice: '持仓暂时无法更新，显示的数据可能已过期。' })
      } finally {
        if (alive && requestId === serial && !document.hidden) timer = window.setTimeout(poll, paperPollDelay(runningRef.current, current))
      }
    }
    const resume = () => {
      baseline = true
      window.clearTimeout(timer)
      serial++
      controller?.abort()
      if (!document.hidden) poll()
    }
    wakeRef.current = poll
    document.addEventListener('visibilitychange', resume)
    window.addEventListener('focus', resume)
    poll()
    return () => {
      alive = false; serial++; controller?.abort(); window.clearTimeout(timer)
      wakeRef.current = null
      document.removeEventListener('visibilitychange', resume)
      window.removeEventListener('focus', resume)
    }
  }, [csrf, onSessionFailure])
  useEffect(() => { if (running) wakeRef.current?.() }, [running])
  return view
}
