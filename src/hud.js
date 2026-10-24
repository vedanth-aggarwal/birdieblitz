const $ = id => document.getElementById(id);

export const hud = {
  show(on) { $('hud').classList.toggle('hidden', !on); },

  setScore(you, cpu, server) {
    setNum('sYou', you); setNum('sCpu', cpu);
    $('dotYou').classList.toggle('on', server === 'you');
    $('dotCpu').classList.toggle('on', server === 'cpu');
  },
  setLevel(name) { $('sLevel').textContent = name; },
  setNames(you, opp) { $('lblYou').textContent = you.toUpperCase(); $('lblCpu').textContent = opp.toUpperCase(); },
  setStamina(v) {
    const bar = $('staminaBar');
    bar.style.width = `${Math.max(0, Math.min(100, v))}%`;
    bar.classList.toggle('low', v < 30);
  },
  setCondition(label) { $('oppCondition').textContent = `Opponent: ${label}`; },
  // Secret-move card from the my_secret view: armed one glows, spent ones are crossed out.
  setSecret(sec) {
    for (const b of document.querySelectorAll('#secretCard button')) {
      const m = b.dataset.move;
      const used = sec ? (m === 'power' ? sec.usedPower : m === 'curve' ? sec.usedCurve : sec.usedFeint) : false;
      b.classList.toggle('armed', !!sec && sec.armed === m);
      b.classList.toggle('used', used);
      b.disabled = used;
    }
  },
  setInput(text, state) {
    const c = $('inputChip');
    c.classList.remove('good', 'wait');
    if (state) c.classList.add(state);
    c.querySelector('span').textContent = text;
  },

  callout(text, color = '#ffd23f') { animate($('callout'), text, color); },
  sub(text, color = '#ffffff') { animate($('subcallout'), text, color); },

  toast(text, ms = 1800) {
    const t = $('toast');
    t.textContent = text; t.classList.add('show');
    clearTimeout(this._tt);
    if (ms) this._tt = setTimeout(() => t.classList.remove('show'), ms);
  },
  hideToast() { $('toast').classList.remove('show'); },
};

function animate(el, text, color) {
  el.textContent = text; el.style.color = color;
  el.classList.remove('go'); void el.offsetWidth; el.classList.add('go');
}
function setNum(id, v) {
  const el = $(id);
  if (el.textContent === String(v)) return;
  el.textContent = v;
  el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
}
