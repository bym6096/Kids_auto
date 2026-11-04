// YouTube Kids 자동 로그인 content script
// - www.youtubekids.com : 로그아웃 화면(보호자입니다 → 로그인 …)을 따라가며 클릭
// - accounts.google.com : 계정 선택 / 이메일 / 비밀번호 / 동의 화면 처리
(() => {
  'use strict';
  if (window.top !== window) return;
  const HOST = location.hostname;
  const IS_YTK = HOST === 'www.youtubekids.com';
  const IS_GOOGLE = HOST === 'accounts.google.com';
  if (!IS_YTK && !IS_GOOGLE) return;

  const TICK_MS = 2000;
  const DEFAULTS = { enabled: true, mode: 'supervised', email: '', password: '', birthYear: '', profile: '' };

  // ---- 문구 패턴 (한국어/영어) ------------------------------------------------
  const RE = {
    parent: /^(보호자입니다|i['’]?m a parent|i am a parent)$/i,
    supervised: /감독 대상|supervised/i,
    next: /^(다음|next)$/i,
    signin: /^(로그인|sign in)$/i,
    parentSigninHeading: /보호자 계정으로 로그인|sign in (with|to) your parent/i,
    consent: /^(계속|continue|허용|allow|확인|confirm)$/i,
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
      cur.push(`[${d.getMonth() + 1}/${d.getDate()} ${t}] (${IS_YTK ? 'kids' : 'google'}) ${msg}`);
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
        if (!b || !cooldown('ytk-parent', 8000) || !(await budget('ytk-parent', 5, 600000))) return false;
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
        if (!b || !cooldown('ytk-welcome', 8000) || !(await budget('ytk-welcome', 5, 600000))) return false;
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
        if (!submit || !cooldown('ytk-agegate', 8000) || !(await budget('ytk-agegate', 4, 600000))) return false;
        await log('생년 입력 후 제출');
        click(submit);
        return true;
      },
    },
    {
      name: 'ytk-signin-info', // 소개 영상 화면의 '다음'
      async run() {
        const b = findVisible('#sign-in-info-next-button');
        if (!b) return false;
        if (!isEnabled(b)) { // 안내 영상 재생이 끝나야 활성화된다 - 건너뛰지 않고 기다린다
          await log('로그인 안내 영상이 끝나 다음 버튼이 활성화되기를 기다립니다', { once: true });
          return false;
        }
        if (!cooldown('ytk-signin-info', 8000) || !(await budget('ytk-signin-info', 4, 600000))) return false;
        await log('로그인 안내 화면: 다음 클릭');
        click(b);
        return true;
      },
    },
    {
      name: 'ytk-parent-signin', // "보호자 계정으로 로그인하세요" 화면 (계정 카드 + 뒤로/건너뛰기/로그인)
      async run() {
        if (!RE.parentSigninHeading.test(document.body.innerText || '')) return false;
        const b = findButton(RE.signin);
        if (!b || !cooldown('ytk-parent-signin', 30000) || !(await budget('ytk-parent-signin', 4, 600000))) return false;
        await log("'보호자 계정으로 로그인' 화면: 로그인 클릭");
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
        if (!target || !cooldown('ytk-profile', 15000) || !(await budget('ytk-profile', 4, 600000))) return false;
        await log('프로필 선택 클릭');
        click(target);
        return true;
      },
    },
  ];

  // ---- Google 로그인 팝업 ----------------------------------------------------
  const GOOGLE_STEPS = [
    {
      name: 'g-manual', // 2단계 인증/캡차 등은 자동화하지 않는다
      async run() {
        const p = location.pathname;
        if (/challenge/.test(p) && !/challenge\/pwd/.test(p)) {
          await log('추가 인증(2단계/본인확인) 화면입니다. 직접 진행해 주세요', { once: true });
          return true; // 이후 단계 중단
        }
        if (/rejected|captcha/.test(p)) {
          await log('구글이 로그인을 거부했거나 캡차를 요구합니다. 직접 진행해 주세요', { once: true });
          return true;
        }
        return false;
      },
    },
    {
      name: 'g-chooser', // 계정 선택
      async run(cfg) {
        const items = deepAll((el) => el.hasAttribute('data-identifier') && isVisible(el));
        if (!items.length) return false;
        const want = cfg.email.toLowerCase();
        const pick = (want && items.find((el) => (el.getAttribute('data-identifier') || '').toLowerCase() === want))
          || (!want ? items[0] : null);
        if (!pick) {
          await log('계정 선택 화면에 설정한 이메일이 없습니다. 직접 선택해 주세요', { once: true });
          return false;
        }
        if (!cooldown('g-chooser', 8000) || !(await budget('g-chooser', 4, 600000))) return false;
        await log('계정 선택 클릭');
        click(pick);
        return true;
      },
    },
    {
      name: 'g-password',
      async run(cfg) {
        const input = findVisible('input[type="password"]');
        if (!input) return false;
        if (!input.value && cfg.password) setValue(input, cfg.password);
        if (!input.value) {
          await log('비밀번호 입력 화면: 저장된 비밀번호가 없고 자동 채우기도 없어 직접 입력을 기다립니다', { once: true });
          return false;
        }
        const next = findVisible('#passwordNext button') || findVisible('#passwordNext') || findButton(RE.next);
        if (!next || !cooldown('g-password', 15000) || !(await budget('g-password', 2, 1800000))) return false;
        await log('비밀번호 제출');
        click(next);
        return true;
      },
    },
    {
      name: 'g-identifier', // 이메일 입력
      async run(cfg) {
        const input = findVisible('input#identifierId, input[type="email"]');
        if (!input) return false;
        if (!input.value && cfg.email) setValue(input, cfg.email);
        if (!input.value) {
          await log('이메일 입력 화면: 설정에 이메일이 없어 직접 입력을 기다립니다', { once: true });
          return false;
        }
        const next = findVisible('#identifierNext button') || findVisible('#identifierNext') || findButton(RE.next);
        if (!next || !cooldown('g-identifier', 12000) || !(await budget('g-identifier', 3, 600000))) return false;
        await log('이메일 제출');
        click(next);
        return true;
      },
    },
    {
      name: 'g-consent', // "YouTube Kids에 계속" 등 동의 화면
      async run() {
        if (!/consent|speedbump|oauth/.test(location.pathname + location.search)) return false;
        const b = findButton(RE.consent);
        if (!b || !cooldown('g-consent', 10000) || !(await budget('g-consent', 4, 600000))) return false;
        await log('동의 화면: 계속 클릭');
        click(b);
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
      for (const step of IS_YTK ? YTK_STEPS : GOOGLE_STEPS) {
        if (await step.run(cfg)) break; // 한 tick 에 한 동작만
      }
    } catch (e) {
      if (!/context invalidated/i.test(String(e))) await log(`오류: ${e && e.message}`);
    } finally {
      running = false;
    }
  }
  setInterval(tick, TICK_MS);
  tick();
})();
