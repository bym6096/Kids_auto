const box = document.getElementById('enabled');
const state = document.getElementById('state');
const render = () => { state.textContent = box.checked ? '켜짐' : '꺼짐 (로그아웃돼도 자동 로그인 안 함)'; };

chrome.storage.local.get({ enabled: true }).then(({ enabled }) => { box.checked = !!enabled; render(); });
box.addEventListener('change', async () => {
  await chrome.storage.local.set({ enabled: box.checked });
  render();
});
document.getElementById('open').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});
