// 아이콘 클릭 / 설치 시 설정 페이지를 연다.
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
chrome.runtime.onInstalled.addListener((d) => {
  if (d.reason === 'install') chrome.runtime.openOptionsPage();
});

// YouTube Kids의 '로그인' 버튼은 구글 로그인 팝업을 띄운다.
// 스크립트가 누른 클릭은 사용자 클릭으로 인정되지 않아 크롬이 팝업을 막으므로,
// youtubekids.com 에 한해서만 팝업을 허용해 둔다.
function allowPopups() {
  try {
    chrome.contentSettings.popups.set({
      primaryPattern: 'https://www.youtubekids.com/*',
      setting: 'allow',
    });
  } catch (e) {
    console.warn('popup 허용 설정 실패', e);
  }
}
chrome.runtime.onInstalled.addListener(allowPopups);
chrome.runtime.onStartup.addListener(allowPopups);
