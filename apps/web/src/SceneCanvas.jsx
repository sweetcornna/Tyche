import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { WORKFLOW_NODES } from './workflow.js'
import { consumeSceneEvents } from './paper-scene.js'

const COLORS = { waiting: '#758b80', pending: '#a3b6ac', running: '#b6ddc8', complete: '#91b5a2', failed: '#d69da3', blocked: '#c7b59a', timeout: '#c7b59a' }
const SYMBOLS = ['BTC_USDT', 'ETH_USDT']

export default function SceneCanvas(props) {
  const host = useRef(null)
  const latest = useRef(props)
  latest.current = props
  useEffect(() => {
    const container = host.current
    let renderer, mixer, model, observer, resize, frame = 0, alive = true, inView = true, firstFrame = true
    let width = 1, height = 1, previousTime = 0, elapsed = 0, eventsRef, pending = [], activeEvent = null
    const materials = new Set(), geometries = new Set(), textures = new Set()
    const pointer = new THREE.Vector2(), ray = new THREE.Raycaster(), projected = new THREE.Vector3()
    const targets = [], agents = new Map(), glows = new Map(), effects = new Map()
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(34, 1, .1, 80)
    const look = new THREE.Vector3(0, .08, 0)
    const disposeTree = (root) => root?.traverse((node) => {
      if (node.geometry) geometries.add(node.geometry)
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
        if (!material) continue
        materials.add(material)
        for (const value of Object.values(material)) if (value?.isTexture) textures.add(value)
      }
    })
    const failure = () => { if (alive) latest.current.onFailure() }
    const contextLost = (event) => { event.preventDefault(); failure() }
    const setSize = () => {
      width = Math.max(1, container.clientWidth); height = Math.max(1, container.clientHeight)
      const ratio = Math.min(window.devicePixelRatio || 1, window.innerWidth < 680 ? 1 : 1.5)
      if (renderer.getPixelRatio() !== ratio) renderer.setPixelRatio(ratio)
      renderer.setSize(width, height)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    }
    const point = (event) => {
      const rect = container.getBoundingClientRect()
      pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
    }
    const click = (event) => {
      point(event)
      ray.setFromCamera(pointer, camera)
      const hit = ray.intersectObjects(targets, false).find(({ object }) => latest.current.mode === 'workflow' ? object.userData.role : object.userData.symbol)
      if (hit?.object.userData.role) latest.current.onSelectAgent?.(hit.object.userData.role)
      if (hit?.object.userData.symbol) latest.current.onSelectAsset?.(hit.object.userData.symbol)
    }
    const motion = (event) => { point(event) }
    const leave = () => pointer.set(0, 0)
    const visible = () => {
      cancelAnimationFrame(frame)
      previousTime = 0
      if (document.hidden) { pending = []; activeEvent = null }
      if (alive && inView && !document.hidden && model) frame = requestAnimationFrame(draw)
    }
    function draw(now) {
      if (!alive || !inView || document.hidden) return
      frame = requestAnimationFrame(draw)
      if (previousTime && now - previousTime < 1000 / 40) return
      const delta = previousTime ? Math.min((now - previousTime) / 1000, .06) : 0
      previousTime = now; elapsed += delta
      const current = latest.current
      const trading = current.mode === 'trading'
      model.getObjectByName('Workflow').visible = !trading
      model.getObjectByName('Trading').visible = trading
      mixer.update(delta)
      // Portrait regions use a wider view; pointer movement is restrained camera parallax.
      const distance = Math.max(5.9, 5.9 / Math.max(.55, camera.aspect)) * (trading ? 1.13 : 1)
      const angle = .62 + pointer.x * .05
      camera.position.set(Math.sin(angle) * distance * .72, distance * .69 + pointer.y * .1, Math.cos(angle) * distance * .72)
      camera.lookAt(look)
      scene.updateMatrixWorld()
      for (const [role, node] of agents) {
        const state = current.workflow?.byRole[role]?.status || 'waiting'
        const color = new THREE.Color(role === current.selected && state === 'waiting' ? '#dce6df' : COLORS[state] || COLORS.waiting)
        for (const mat of glows.get(role)) {
          mat.color.copy(color).multiplyScalar(state === 'running' ? .9 + Math.sin(elapsed * 2) * .1 : 1)
          if (mat.emissive) { mat.emissive.copy(color); mat.emissiveIntensity = 0 }
        }
        const label = container.querySelector(`[data-scene-role="${role}"]`)
        if (label && !trading) {
          node.getWorldPosition(projected); projected.project(camera)
          label.style.transform = `translate(${(projected.x + 1) * width / 2}px, ${(-projected.y + 1) * height / 2}px) translate(-50%, -50%)`
        }
      }
      if (eventsRef !== current.events) {
        eventsRef = current.events
        pending.push(...consumeSceneEvents(current.events, current.seenEvents))
        if (pending.length > 12) pending = pending.slice(-12)
      }
      if (!activeEvent && pending.length) activeEvent = { event: pending.shift(), start: elapsed }
      if (activeEvent && elapsed - activeEvent.start > 1.3) activeEvent = null
      for (const [symbol, fx] of effects) {
        const position = current.paper?.positions?.find((row) => row.symbol === symbol)
        const order = current.paper?.orders?.some((row) => row.symbol === symbol)
        const event = activeEvent?.event.symbol === symbol ? activeEvent : null
        const total = Number(current.paper?.summary?.locked_margin || 0)
        const proportion = position && total > 0 ? Number(position.margin) / total : 0
        fx.gauge.geometry.setDrawRange(0, Math.round(Math.max(0, Math.min(1, proportion)) * 64) * 6)
        fx.group.visible = trading
        const warning = event && ['SIMULATED_CANCELLED', 'SIMULATED_LIQUIDATION', 'SIMULATION_EVIDENCE_GAP'].includes(event.event.type)
        const exiting = event && (event.event.type === 'SIMULATED_POSITION_CLOSED' || event.event.role === 'REDUCTION')
        fx.line.material.color.set(warning ? '#d69da3' : '#afc6b8')
        fx.line.material.opacity = event ? .6 : order ? .3 : 0
        fx.bead.visible = Boolean(order || event)
        fx.bead.material.color.set(warning ? '#d69da3' : '#d6e5dd')
        const t = event ? Math.min(1, (elapsed - event.start) / 1.25) : (elapsed * .25) % 1
        fx.bead.position.copy(fx.curve.getPoint(exiting ? 1 - t : t))
        fx.bead.scale.setScalar(warning ? Math.max(.1, 1 - t) : .7 + Math.sin(t * Math.PI) * .5)
        fx.gauge.material.color.set(position?.side === 'short' ? '#a9b4c9' : '#a5c0b0')
      }
      renderer.render(scene, camera)
      if (firstFrame) { firstFrame = false; latest.current.onReady() }
    }
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' })
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, window.innerWidth < 680 ? 1 : 1.5))
      renderer.setClearColor(0, 0)
      renderer.toneMapping = THREE.NoToneMapping
      renderer.toneMappingExposure = 1.05
      renderer.domElement.setAttribute('aria-hidden', 'true')
      container.prepend(renderer.domElement)
      setSize()
      resize = new ResizeObserver(setSize); resize.observe(container)
      observer = new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; visible() }, { threshold: .05 }); observer.observe(container)
      renderer.domElement.addEventListener('webglcontextlost', contextLost)
      container.addEventListener('pointermove', motion)
      container.addEventListener('pointerleave', leave)
      renderer.domElement.addEventListener('click', click)
      document.addEventListener('visibilitychange', visible)
      new GLTFLoader().load('/models/tyche-console.glb', (gltf) => {
        if (!alive) {
          disposeTree(gltf.scene); for (const item of geometries) item.dispose(); for (const item of materials) item.dispose(); for (const item of textures) item.dispose()
          return
        }
        model = gltf.scene
        if (!model.getObjectByName('Workflow') || !model.getObjectByName('Trading')) { disposeTree(model); failure(); return }
        scene.add(model)
        mixer = new THREE.AnimationMixer(model)
        for (const clip of gltf.animations) {
          const action = mixer.clipAction(clip)
          if (clip.name === 'Reveal') { action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true }
          else action.timeScale = .18
          action.play()
        }
        for (const { role } of WORKFLOW_NODES) {
          const node = model.getObjectByName(`agent_${role}`)
          if (!node) continue
          agents.set(role, node); glows.set(role, [])
          node.traverse((part) => {
            if (!part.isMesh) return
            part.userData.role = role; targets.push(part)
            if (part.name.startsWith('Agent_glow') || part.name.startsWith('Agent_ring')) {
              part.material = part.material.clone(); glows.get(role).push(part.material)
            }
          })
        }
        for (const [index, symbol] of SYMBOLS.entries()) {
          const node = model.getObjectByName(`asset_${symbol}`)
          node?.traverse((part) => { if (part.isMesh) { part.userData.symbol = symbol; targets.push(part) } })
          const x = index === 0 ? -1.24 : 1.24
          const group = new THREE.Group()
          const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(0, .1, .5), new THREE.Vector3(x * .4, 1.1, .3), new THREE.Vector3(x, .5, 0)])
          const line = new THREE.Mesh(new THREE.TubeGeometry(curve, 32, .012, 5, false), new THREE.MeshBasicMaterial({ color: '#65e6ff', transparent: true, opacity: .1, depthWrite: false }))
          const bead = new THREE.Mesh(new THREE.IcosahedronGeometry(.055, 1), new THREE.MeshBasicMaterial({ color: '#b0f4ff' }))
          const gauge = new THREE.Mesh(new THREE.RingGeometry(.61, .625, 64), new THREE.MeshBasicMaterial({ color: '#5ee2ef', side: THREE.DoubleSide }))
          gauge.rotation.x = -Math.PI / 2; gauge.position.set(x, -.095, 0)
          group.add(line, bead, gauge); scene.add(group)
          effects.set(symbol, { group, curve, line, bead, gauge })
        }
        visible()
      }, undefined, failure)
    } catch { failure() }
    return () => {
      alive = false; cancelAnimationFrame(frame)
      observer?.disconnect(); resize?.disconnect()
      document.removeEventListener('visibilitychange', visible)
      container.removeEventListener('pointermove', motion); container.removeEventListener('pointerleave', leave)
      renderer?.domElement.removeEventListener('click', click)
      renderer?.domElement.removeEventListener('webglcontextlost', contextLost)
      mixer?.stopAllAction(); if (model) mixer?.uncacheRoot(model)
      disposeTree(scene)
      for (const item of geometries) item.dispose()
      for (const item of materials) item.dispose()
      for (const item of textures) item.dispose()
      renderer?.dispose(); renderer?.domElement.remove()
    }
  }, [])
  return <div className="scene-canvas" ref={host}>
    {props.mode === 'workflow' && !props.decorative && <div className="scene-labels">{WORKFLOW_NODES.map(({ role, name }) => <button key={role} type="button" data-scene-role={role} data-status={props.workflow?.byRole[role]?.status || 'waiting'} className="scene-node-target" aria-label={name} title={name} aria-pressed={props.selected === role} onClick={() => props.onSelectAgent(role)} />)}</div>}
  </div>
}
