const FIELDS = ['birthYear', 'profile', 'mode'];
const DEFAULTS = { enabled: true, mode: 'supervised', birthYear: '', profile: '' };
const $ = (id) => document.getElementById(id);

async function load() {
  const s = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
  $('enabled').checked = !!s.enabled;
  FIELDS.forEach((f) => { $(f).value = s[f] || ''; });
  await showLog();
}

async function save() {
  const data = { enabled: $('enabled').checked };
  FIELDS.forEach((f) => { data[f] = $(f).value.trim(); });
  if (data.birthYear && !/^\d{4}$/.test(data.birthYear)) {
    $('status').style.color = '#b00020';
    $('status').textContent = '생년은 숫자 4자리여야 합니다.';
    return;
  }
  await chrome.storage.local.set(data);
  $('status').style.color = '#0a7a2f';
  $('status').textContent = '저장됨';
  setTimeout(() => ($('status').textContent = ''), 2000);
}

async function showLog() {
  const { log = [] } = await chrome.storage.local.get('log');
  $('log').textContent = log.length ? log.slice().reverse().join('\n') : '(기록 없음)';
}

$('save').addEventListener('click', save);
$('refresh').addEventListener('click', showLog);
$('clear').addEventListener('click', async () => {
  await chrome.storage.local.remove(['log', 'attempts']);
  await showLog();
});
load();
