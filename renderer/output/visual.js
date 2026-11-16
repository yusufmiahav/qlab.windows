// Shared by the stage window and the overlay curtain: renders "hold + optional still"
// into a container with a CSS crossfade between successive visuals.
function paint(el, v) {
  el.style.backgroundColor = v && v.type === 'colour' ? v.colour : v && v.type === 'image' ? '#000' : 'transparent';
  el.style.backgroundImage = v && v.type === 'image' && v.url ? `url("${v.url}")` : 'none';
}
function preloadImage(url) {
  return new Promise((resolve) => {
    if (!url) return resolve();
    const img = new Image();
    img.onload = img.onerror = () => resolve();
    img.src = url;
    setTimeout(resolve, 400);
  });
}
// root must contain: .hold, .va, .vb
function createVisual(root) {
  const hold = root.querySelector('.hold');
  const layers = [root.querySelector('.va'), root.querySelector('.vb')];
  let front = 0, lastKey = 'null', token = 0;
  return async function update(state) {
    paint(hold, state.hold);
    const key = JSON.stringify(state.visual);
    if (key === lastKey) return;
    lastKey = key;
    const my = ++token;
    const ms = state.fadeMs || 0;
    const incoming = layers[1 - front], outgoing = layers[front];
    if (state.visual) {
      await preloadImage(state.visual.type === 'image' ? state.visual.url : '');
      if (my !== token) return;
      paint(incoming, state.visual);
      incoming.style.transition = `opacity ${ms}ms linear`;
      outgoing.style.transition = `opacity ${ms}ms linear`;
      incoming.style.zIndex = 2; outgoing.style.zIndex = 1;
      void incoming.offsetWidth;
      incoming.style.opacity = 1;
      // keep the outgoing still underneath until the new one is fully up, then drop it
      setTimeout(() => { if (my === token) { outgoing.style.transition = 'none'; outgoing.style.opacity = 0; } }, ms + 30);
      front = 1 - front;
    } else {
      for (const l of layers) { l.style.transition = `opacity ${ms}ms linear`; l.style.opacity = 0; }
    }
  };
}
