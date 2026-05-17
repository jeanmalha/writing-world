const LS_KEY = 'lore_layout'; // 'auto' | 'desktop' | 'mobile'

function _apply() {
  const pref = localStorage.getItem(LS_KEY) || 'auto';
  const mobile = pref === 'mobile' || (pref === 'auto' && window.innerWidth <= 768);
  document.body.classList.toggle('layout-mobile', mobile);
  document.body.classList.toggle('layout-desktop', !mobile);
}

export function getLayoutPref() {
  return localStorage.getItem(LS_KEY) || 'auto';
}

export function setLayoutPref(pref) {
  localStorage.setItem(LS_KEY, pref);
  _apply();
}

export function isMobileLayout() {
  return document.body.classList.contains('layout-mobile');
}

export function initLayout(onLayoutChange) {
  _apply();
  let _prevMobile = isMobileLayout();
  window.addEventListener('resize', () => {
    _apply();
    const nowMobile = isMobileLayout();
    if (nowMobile !== _prevMobile) {
      _prevMobile = nowMobile;
      onLayoutChange?.();
    }
  });
}
