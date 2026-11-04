// YouTube Kids 자동 로그인 content script
// www.youtubekids.com 의 로그아웃 화면(보호자입니다 → … → 로그인)을 따라가며 클릭한다.
(() => {
  'use strict';
  if (window.top !== window) return;
  if (location.hostname !== 'www.youtubekids.com') return;

  const FAST_MS = 250;   // 로그인 진행 중
  const IDLE_MS = 2000;  // 평소(이미 로그인된 화면 감시)
  const FAST_WINDOW_MS = 45000;
  let fastUntil = Date.now() + FAST_WINDOW_MS; // 페이지 로드 직후엔 빠르게
  const DEFAULTS = { enabled: true, mode: 'supervised', birthYear: '', profile: '' };

  // ---- 문구 패턴 (한국어/영어) ------------------------------------------------
  const RE = {
    parent: /^(보호자입니다|i['’]?m a parent|i am a parent)$/i,
    supervised: /감독 대상|supervised/i,
    next: /^(다음|next)$/i,
    signin: /^(로그인|sign in)$/i,
    ok: /^(확인|ok|got it)$/i,
    tourHeading: /보호자 기능 둘러보기|parent (features|tour)/i,
    parentSigninHeading: /보호자 계정으로 로그인|sign in (with|to) your parent/i,
    profileHeading: /누가 시청|who['’]?s watching/i,
  };

  // ---- 기록 / 재시도 제한 -------------------------------------------------------
  const seenLogs = new Set();
  async function log(msg, { once = false } = {}) {
    if (once) { if (seenLogs.has(msg)) return; seenLogs.add(msg); }
    try {
      const d = new Date();
      const t = d.toTimeString().slice(0, 8);
      const { log: cur = [] } = await chrome.storage.local.get('log');
      cur.push(`[${d.getMonth() + 1}/${d.getDate()} ${t}] ${msg}`);
      await chrome.storage.local.set({ log: cur.slice(-80) });
    } catch (_) { /* 확장 재로드 등 */ }
  }

  // 같은 단계를 windowMs 안에 max번 넘게 시도하지 않는다 (무한 반복/계정 잠금 방지).
  async function budget(step, max, windowMs) {
    try {
      const { attempts = {} } = await chrome.storage.local.get('attempts');
      const now = Date.now();
      const list = (attempts[step] || []).filter((t) => now - t < windowMs);
      if (list.length >= max) {
        attempts[step] = list;
        await chrome.storage.local.set({ attempts });
        await log(`'${step}' 단계 재시도 한도(${max}회/${Math.round(windowMs / 60000)}분) 초과 - 중단`, { once: true });
        return false;
      }
      list.push(now);
      attempts[step] = list;
      await chrome.storage.local.set({ attempts });
      return true;
    } catch (_) { return false; }
  }

  // ---- DOM 유틸 (shadow DOM 포함) -----------------------------------------------
  function deepAll(pred, root = document) {
    const out = [];
    const stack = [root];
    while (stack.length) {
      const r = stack.pop();
      for (const el of r.querySelectorAll('*')) {
        if (pred(el)) out.push(el);
        if (el.shadowRoot) stack.push(el.shadowRoot);
      }
    }
    return out;
  }
  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  }
  const isEnabled = (el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true';
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const labelOf = (el) => norm(el.innerText || el.textContent || '');
  const CLICKABLE = new Set(['BUTTON', 'A', 'TP-YT-PAPER-ICON-BUTTON']);
  function findButton(re, scope) {
    const root = scope || document;
    return deepAll((el) => (CLICKABLE.has(el.tagName) || el.getAttribute('role') === 'button')
      && re.test(labelOf(el)) && isVisible(el) && isEnabled(el), root)[0] || null;
  }
  const findVisible = (selector) => deepAll((el) => el.matches(selector) && isVisible(el))[0] || null;
  function click(el) { el.click(); }
  function setValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    input.focus();
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  }

  // ---- YouTube Kids ----------------------------------------------------------
  const lastClick = {};
  const cooldown = (key, ms) => {
    const now = Date.now();
    if (lastClick[key] && now - lastClick[key] < ms) return false;
    lastClick[key] = now;
    return true;
  };

  const YTK_STEPS = [
    {
      name: 'ytk-parent', // "어린이입니다 / 보호자입니다"
      async run() {
        const b = findButton(RE.parent);
        if (!b || !cooldown('ytk-parent', 1500) || !(await budget('ytk-parent', 5, 600000))) return false;
        await log("'보호자입니다' 클릭");
        click(b);
        return true;
      },
    },
    {
      name: 'ytk-welcome', // "환영합니다 … 다음 / 또는 감독 대상 Google 계정으로 로그인"
      async run(cfg) {
        const page = findVisible('ytk-kids-onboarding-welcome-page-renderer');
        if (!page) return false;
        const b = findButton(cfg.mode === 'parent' ? RE.next : RE.supervised, page);
        if (!b || !cooldown('ytk-welcome', 1500) || !(await budget('ytk-welcome', 5, 600000))) return false;
        await log(cfg.mode === 'parent' ? "환영 화면: '다음' 클릭" : '환영 화면: 감독 대상 계정 로그인 클릭');
        click(b);
        return true;
      },
    },
    {
      name: 'ytk-agegate', // 출생 연도 4자리
      async run(cfg) {
        const page = findVisible('ytk-kids-onboarding-age-gate-renderer');
        if (!page) return false;
        if (!/^\d{4}$/.test(cfg.birthYear)) {
          await log('생년 입력 화면: 설정에 생년이 없어 직접 입력을 기다립니다', { once: true });
          return false;
        }
        const inputs = [1, 2, 3, 4].map((i) => deepAll((e) => e.id === `onboarding-age-gate-digit-${i}`, page)[0]);
        if (inputs.some((i) => !i)) return false;
        const want = cfg.birthYear.split('');
        if (inputs.some((inp, i) => inp.value !== want[i])) {
          inputs.forEach((inp, i) => setValue(inp, want[i]));
          return true; // 다음 tick 에 제출
        }
        const submit = findButton(/^(제출|submit)$/i, page);
        if (!submit || !cooldown('ytk-agegate', 1500) || !(await budget('ytk-agegate', 4, 600000))) return false;
        await log('생년 입력 후 제출');
        click(submit);
        return true;
      },
    },
    {
      name: 'ytk-signin-info', // 안내 영상 화면: 영상 '다음'은 비활성이므로 '텍스트 표시'로 넘어간다
      async run() {
        const next = findVisible('#sign-in-info-next-button');
        if (!next) return false;
        const btn = isEnabled(next) ? next : findVisible('#show-text-link');
        if (!btn || !cooldown('ytk-signin-info', 1500) || !(await budget('ytk-signin-info', 5, 600000))) return false;
        await log(isEnabled(next) ? '로그인 안내 화면: 다음 클릭' : "로그인 안내 영상: '텍스트 표시' 클릭");
        click(btn);
        return true;
      },
    },
    {
      name: 'ytk-tour', // "보호자 기능 둘러보기" 안내 -> 확인 (옆 화살표(>)는 누르지 않는다)
      async run() {
        if (!RE.tourHeading.test(document.body.innerText || '')) return false;
        const b = findButton(RE.ok);
        if (!b || !cooldown('ytk-tour', 2000) || !(await budget('ytk-tour', 4, 600000))) return false;
        await log("'보호자 기능 둘러보기': 확인 클릭");
        click(b);
        return true;
      },
    },
    {
      name: 'ytk-parent-signin', // "보호자 계정으로 로그인하세요" 화면 (계정 카드 + 뒤로/건너뛰기/로그인)
      async run() {
        if (!RE.parentSigninHeading.test(document.body.innerText || '')) return false;
        const b = findButton(RE.signin);
        if (!b || !cooldown('ytk-signin', 30000) || !(await budget('ytk-signin', 4, 600000))) return false;
        await log("'보호자 계정으로 로그인' 화면: 로그인 클릭");
        click(b);
        return true;
      },
    },
    {
      name: 'ytk-signin-info-text', // '텍스트 표시' 이후 화면의 활성화된 '다음'
      async run() {
        if (!RE.parentSigninHeading.test(document.body.innerText || '')) return false;
        if (findButton(RE.signin)) return false; // 로그인 버튼이 있는 화면이면 해당 단계가 처리
        const b = findVisible('#next-button');
        if (!b || !isEnabled(b) || !cooldown('ytk-signin-info-text', 1500) || !(await budget('ytk-signin-info-text', 4, 600000))) return false;
        await log('텍스트 안내 화면: 다음 클릭');
        click(b);
        return true;
      },
    },
    {
      name: 'ytk-signin', // "로그인" 버튼 -> 구글 로그인 팝업
      async run() {
        const b = findVisible('#signin-button');
        if (!b || !isEnabled(b) || !cooldown('ytk-signin', 30000) || !(await budget('ytk-signin', 4, 600000))) return false;
        await log("'로그인' 클릭 (구글 팝업이 열려야 합니다)");
        click(b);
        return true;
      },
    },
    {
      name: 'ytk-profile', // 프로필 선택 (화면 구조 미검증 - 이름 텍스트로 매칭)
      async run(cfg) {
        if (!cfg.profile) return false;
        if (!RE.profileHeading.test(document.body.innerText || '')) return false;
        const target = deepAll((el) => (CLICKABLE.has(el.tagName) || el.getAttribute('role') === 'button')
          && labelOf(el).includes(cfg.profile) && isVisible(el))[0];
        if (!target || !cooldown('ytk-profile', 3000) || !(await budget('ytk-profile', 4, 600000))) return false;
        await log('프로필 선택 클릭');
        click(target);
        return true;
      },
    },
  ];

  // ---- 메인 루프 ----------------------------------------------------------------
  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      const cfg = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
      if (!cfg.enabled) return;
      for (const step of YTK_STEPS) {
        if (await step.run(cfg)) { // 한 tick 에 한 동작만
          fastUntil = Date.now() + FAST_WINDOW_MS;
          break;
        }
      }
    } catch (e) {
      if (!/context invalidated/i.test(String(e))) await log(`오류: ${e && e.message}`);
    } finally {
      running = false;
    }
  }
  (function loop() {
    tick().finally(() => setTimeout(loop, Date.now() < fastUntil ? FAST_MS : IDLE_MS));
  })();
})();
