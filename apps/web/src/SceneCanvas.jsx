import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { WORKFLOW_NODES } from './workflow.js'
import { consumeSceneEvents } from './paper-scene.js'
import { spring, createGrip, holdGrip, turnGrip, releaseGrip, settleGrip } from './scene-motion.js'

const COLORS = { waiting: '#758b80', pending: '#a3b6ac', running: '#b6ddc8', complete: '#91b5a2', failed: '#d69da3', blocked: '#c7b59a', timeout: '#c7b59a' }
const SYMBOLS = ['BTC_USDT', 'ETH_USDT']
const WARNINGS = ['SIMULATED_CANCELLED', 'SIMULATED_LIQUIDATION', 'SIMULATION_EVIDENCE_GAP']
// Hit sphere [radius, height]; how far hover stands a shape toward the viewer and leans it toward the
// pointer (radians); idle spin with and without a position, and the extra spin while hovered (rad/s).
const FEEL = {
  BTC_USDT: { hit: [.56, 0], face: .42, lean: .26, spin: [.3, .12], boost: .5 },
  ETH_USDT: { hit: [.48, .14], face: .12, lean: .32, spin: [.45, .16], boost: 1.6 }
}
const clamp = (value) => Math.max(-1.2, Math.min(1.2, value))

export default function SceneCanvas(props) {
  const host = useRef(null)
  const latest = useRef(props)
  latest.current = props
  useEffect(() => {
    const container = host.current
    let renderer, mixer, model, observer, resize, frame = 0, alive = true, inView = true, firstFrame = true
    let width = 1, height = 1, previousTime = 0, elapsed = 0, eventsRef, pending = [], activeEvent = null, announced = null
    let inside = false, hovered = null, grab = null, suppressClick = false, selection = null
    const materials = new Set(), geometries = new Set(), textures = new Set()
    const pointer = new THREE.Vector2(), view = new THREE.Vector2(), ray = new THREE.Raycaster(), projected = new THREE.Vector3(), edge = new THREE.Vector3()
    const right = new THREE.Vector3(1, 0, 0), up = new THREE.Vector3(0, 1, 0), vertical = new THREE.Vector3(0, 1, 0), axis = new THREE.Vector3()
    const lean = new THREE.Quaternion(), stand = new THREE.Quaternion(), idle = new THREE.Quaternion()
    const targets = [], proxies = [], agents = new Map(), glows = new Map(), effects = new Map()
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
    const interactive = () => Boolean(model) && latest.current.mode === 'trading' && !latest.current.decorative
    // Invisible spheres make each shape one generous target, including the ring's hole.
    const assetAt = () => { ray.setFromCamera(pointer, camera); return ray.intersectObjects(proxies, false)[0]?.object.userData.symbol || null }
    const click = (event) => {
      if (suppressClick) { suppressClick = false; return }
      point(event)
      if (latest.current.mode !== 'workflow') {
        const symbol = assetAt()
        if (symbol) latest.current.onSelectAsset?.(symbol)
        return
      }
      ray.setFromCamera(pointer, camera)
      const role = ray.intersectObjects(targets, false).find(({ object }) => object.userData.role)?.object.userData.role
      if (role) latest.current.onSelectAgent?.(role)
    }
    const press = (event) => {
      suppressClick = false
      if (!interactive() || event.button !== 0) return
      point(event)
      const symbol = assetAt()
      if (!symbol) return
      event.preventDefault()
      grab = { symbol, id: event.pointerId, x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, lastTime: event.timeStamp, moved: false }
      holdGrip(effects.get(symbol).grip)
      try { renderer.domElement.setPointerCapture(event.pointerId) } catch { /* the drag still works inside the canvas */ }
    }
    const motion = (event) => {
      point(event); inside = true
      if (!grab || event.pointerId !== grab.id) return
      if (!grab.moved && Math.hypot(event.clientX - grab.x, event.clientY - grab.y) < 5) return
      grab.moved = true
      const dx = event.clientX - grab.lastX, dy = event.clientY - grab.lastY, dt = (event.timeStamp - grab.lastTime) / 1000
      grab.lastX = event.clientX; grab.lastY = event.clientY; grab.lastTime = event.timeStamp
      // The front follows the pointer: right turns it rightward, down tips its top toward the viewer.
      if (dx || dy) turnGrip(effects.get(grab.symbol).grip, axis.copy(up).multiplyScalar(dx).addScaledVector(right, dy).normalize(), Math.hypot(dx, dy) * .014, dt)
    }
    const release = (event) => {
      if (!grab || event.pointerId !== grab.id) return
      releaseGrip(effects.get(grab.symbol).grip, event.type === 'pointerup' ? (event.timeStamp - grab.lastTime) / 1000 : Infinity)
      suppressClick = event.type === 'pointerup' && grab.moved
      grab = null
    }
    const leave = () => { pointer.set(0, 0); inside = false }
    const visible = () => {
      cancelAnimationFrame(frame)
      previousTime = 0
      if (document.hidden) { pending = []; activeEvent = null }
      if (alive && inView && !document.hidden && model) frame = requestAnimationFrame(draw)
    }
    const pulse = (symbol, warning) => {
      const fx = effects.get(symbol)
      if (!fx) return
      fx.rippleAt = elapsed; fx.rippleWarning = warning; fx.pop.v -= 12
    }
    function draw(now) {
      if (!alive || !inView || document.hidden) return
      frame = requestAnimationFrame(draw)
      if (previousTime && now - previousTime < 1000 / 40) return
      const delta = previousTime ? Math.min((now - previousTime) / 1000, .06) : 0
      previousTime = now; elapsed += delta
      const current = latest.current
      const trading = current.mode === 'trading'
      const active = trading && !current.decorative
      if (grab && !active) { releaseGrip(effects.get(grab.symbol).grip, Infinity); grab = null }
      model.getObjectByName('Workflow').visible = !trading
      model.getObjectByName('Trading').visible = trading
      mixer.update(delta)
      // Portrait regions use a wider view; restrained camera parallax eases after the pointer and holds during a grab.
      const ease = grab ? 0 : 1 - Math.exp(-delta * 5)
      view.x += (pointer.x - view.x) * ease; view.y += (pointer.y - view.y) * ease
      const distance = Math.max(5.9, 5.9 / Math.max(.55, camera.aspect)) * (trading ? 1.13 : 1)
      const angle = .62 + view.x * .05
      camera.position.set(Math.sin(angle) * distance * .72, distance * .69 + view.y * .1, Math.cos(angle) * distance * .72)
      camera.lookAt(look)
      camera.updateMatrixWorld()
      right.set(1, 0, 0).applyQuaternion(camera.quaternion); up.set(0, 1, 0).applyQuaternion(camera.quaternion)
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
      if (activeEvent && activeEvent !== announced) { announced = activeEvent; pulse(activeEvent.event.symbol, WARNINGS.includes(activeEvent.event.type)) }
      // A fresh selection ripples once; a remount does not replay an old one.
      if (current.selection !== selection) { selection = current.selection; if (selection && performance.now() - selection.at < 1500) pulse(selection.symbol, false) }
      const next = !active ? null : grab ? grab.symbol : inside ? assetAt() : null
      if (next !== hovered) { hovered = next; current.onHoverAsset?.(hovered) }
      const cursor = grab ? 'grabbing' : hovered ? 'grab' : ''
      if (renderer.domElement.style.cursor !== cursor) renderer.domElement.style.cursor = cursor
      for (const [symbol, fx] of effects) {
        const position = current.paper?.positions?.find((row) => row.symbol === symbol)
        const order = current.paper?.orders?.some((row) => row.symbol === symbol)
        const event = activeEvent?.event.symbol === symbol ? activeEvent : null
        const total = Number(current.paper?.summary?.locked_margin || 0)
        const proportion = position && total > 0 ? Number(position.margin) / total : 0
        // The ring length eases toward the locked-margin share; display only.
        spring(fx.share, Math.max(0, Math.min(1, proportion)), delta, 40, 13)
        fx.gauge.geometry.setDrawRange(0, Math.round(Math.max(0, Math.min(1, fx.share.x)) * 64) * 6)
        fx.group.visible = trading
        const warning = event && WARNINGS.includes(event.event.type)
        const exiting = event && (event.event.type === 'SIMULATED_POSITION_CLOSED' || event.event.role === 'REDUCTION')
        fx.line.material.color.set(warning ? '#d69da3' : '#afc6b8')
        fx.line.material.opacity = event ? .6 : order ? .3 : 0
        fx.bead.visible = Boolean(order || event)
        fx.bead.material.color.set(warning ? '#d69da3' : '#d6e5dd')
        const t = event ? Math.min(1, (elapsed - event.start) / 1.25) : (elapsed * .25) % 1
        fx.bead.position.copy(fx.curve.getPoint(exiting ? 1 - t : t))
        fx.bead.scale.setScalar(warning ? Math.max(.1, 1 - t) : .7 + Math.sin(t * Math.PI) * .5)
        const tone = position?.side === 'short' ? '#a9b4c9' : '#a5c0b0'
        fx.gauge.material.color.set(tone)
        const focus = active && (symbol === hovered || symbol === current.hoverAsset)
        const glow = focus ? .42 : symbol === current.selectedAsset ? .16 : 0
        fx.track.material.opacity += (glow - fx.track.material.opacity) * (1 - Math.exp(-delta * 8))
        fx.track.visible = fx.track.material.opacity > .01
        fx.track.material.color.set(tone)
        const ripple = (elapsed - fx.rippleAt) / .85
        fx.ripple.visible = ripple >= 0 && ripple < 1
        if (fx.ripple.visible) {
          fx.ripple.scale.setScalar(1 + .6 * (1 - (1 - ripple) ** 3))
          fx.ripple.material.opacity = .55 * (1 - ripple) ** 2
          fx.ripple.material.color.set(fx.rippleWarning ? '#d69da3' : tone)
        }
        if (!fx.shape) continue
        const feel = FEEL[symbol]
        spring(fx.hover, focus ? 1 : 0, delta, 150, 17)
        spring(fx.pop, grab?.symbol === symbol ? 1 : 0, delta, 380, 15)
        let leanX = 0, leanY = 0
        if (symbol === hovered && inside && !grab) {
          fx.proxy.getWorldPosition(projected)
          edge.copy(projected).addScaledVector(right, feel.hit[0] * (fx.node?.scale.x ?? 1))
          projected.project(camera); edge.project(camera)
          const radius = Math.max(.02, Math.abs(edge.x - projected.x))
          leanX = clamp((pointer.x - projected.x) / radius); leanY = clamp((pointer.y - projected.y) / radius * height / width)
        }
        spring(fx.leanX, leanX, delta, 90, 14); spring(fx.leanY, leanY, delta, 90, 14)
        fx.rate += ((position ? feel.spin[0] : feel.spin[1]) + feel.boost * fx.hover.x - fx.rate) * (1 - Math.exp(-delta * 3))
        fx.angle += fx.rate * delta
        settleGrip(fx.grip, delta)
        // World-space thrown offset, then lean toward the pointer, stand toward the viewer, then the idle turn.
        lean.setFromAxisAngle(up, feel.lean * fx.leanX.x)
        stand.setFromAxisAngle(right, feel.face * fx.hover.x - feel.lean * fx.leanY.x)
        idle.setFromAxisAngle(vertical, fx.angle)
        fx.shape.quaternion.copy(fx.grip.q).multiply(lean).multiply(stand).multiply(idle).multiply(fx.rest)
        fx.shape.position.y = fx.baseY + .1 * fx.hover.x
        fx.shape.scale.setScalar(1 + .08 * fx.hover.x - .09 * fx.pop.x)
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
      renderer.domElement.addEventListener('pointerdown', press)
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) renderer.domElement.addEventListener(type, release)
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
          const holder = model.getObjectByName(`Asset_hover_${symbol}`)
          const shape = holder?.children[0]
          const x = index === 0 ? -1.24 : 1.24
          const group = new THREE.Group()
          const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(0, .1, .5), new THREE.Vector3(x * .4, 1.1, .3), new THREE.Vector3(x, .5, 0)])
          const line = new THREE.Mesh(new THREE.TubeGeometry(curve, 32, .012, 5, false), new THREE.MeshBasicMaterial({ color: '#65e6ff', transparent: true, opacity: .1, depthWrite: false }))
          const bead = new THREE.Mesh(new THREE.IcosahedronGeometry(.055, 1), new THREE.MeshBasicMaterial({ color: '#b0f4ff' }))
          // The floor ring carries the margin gauge, a faint track for hover and selection, and a one-shot ripple.
          const floor = (material, drop) => {
            const mesh = new THREE.Mesh(new THREE.RingGeometry(.61, .625, 64), material)
            mesh.rotation.x = -Math.PI / 2; mesh.position.set(x, -.095 - drop, 0)
            return mesh
          }
          const faint = () => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide })
          const gauge = floor(new THREE.MeshBasicMaterial({ color: '#5ee2ef', side: THREE.DoubleSide }), 0)
          const track = floor(faint(), .002), ripple = floor(faint(), .001)
          track.visible = ripple.visible = false
          group.add(line, bead, track, ripple, gauge); scene.add(group)
          let proxy = null
          if (shape) {
            proxy = new THREE.Mesh(new THREE.SphereGeometry(FEEL[symbol].hit[0], 16, 12), new THREE.MeshBasicMaterial({ visible: false }))
            proxy.position.y = FEEL[symbol].hit[1]; proxy.userData.symbol = symbol
            holder.add(proxy); proxies.push(proxy)
          }
          effects.set(symbol, { group, curve, line, bead, gauge, track, ripple, node, shape, proxy, rest: shape?.quaternion.clone(), baseY: shape?.position.y || 0,
            grip: createGrip(), hover: { x: 0, v: 0 }, pop: { x: 0, v: 0 }, leanX: { x: 0, v: 0 }, leanY: { x: 0, v: 0 }, share: { x: 0, v: 0 },
            rate: FEEL[symbol].spin[1], angle: 0, rippleAt: -9, rippleWarning: false })
        }
        visible()
      }, undefined, failure)
    } catch { failure() }
    return () => {
      alive = false; cancelAnimationFrame(frame)
      if (hovered) latest.current.onHoverAsset?.(null)
      observer?.disconnect(); resize?.disconnect()
      document.removeEventListener('visibilitychange', visible)
      container.removeEventListener('pointermove', motion); container.removeEventListener('pointerleave', leave)
      renderer?.domElement.removeEventListener('click', click)
      renderer?.domElement.removeEventListener('pointerdown', press)
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) renderer?.domElement.removeEventListener(type, release)
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
