(() => {
  const FRONTEND_BUNDLE = './assets/index-CwW5p8N1.js';
  const PATCH_ATTRIBUTE = 'data-delete-with-history-patch';
  let runtimeConfigPromise = null;

  async function getRuntimeConfig() {
    if (!runtimeConfigPromise) {
      runtimeConfigPromise = (async () => {
        const source = await fetch(FRONTEND_BUNDLE, { cache: 'force-cache' }).then((response) => {
          if (!response.ok) throw new Error('تعذر قراءة إعدادات الاتصال.');
          return response.text();
        });
        const url = source.match(/https:\/\/[a-z0-9]+\.supabase\.co/i)?.[0] || '';
        const apiKey = source.match(/sb_publishable_[A-Za-z0-9_-]+/)?.[0] || '';
        if (!url || !apiKey) throw new Error('تعذر تحديد إعدادات الاتصال.');
        const projectRef = new URL(url).hostname.split('.')[0];
        return { url, apiKey, sessionKey: `sb-${projectRef}-auth-token` };
      })();
    }
    return runtimeConfigPromise;
  }

  async function getAccessToken() {
    const config = await getRuntimeConfig();
    try {
      const raw = window.localStorage.getItem(config.sessionKey);
      if (!raw) return { config, token: '' };
      const session = JSON.parse(raw);
      return {
        config,
        token: session?.access_token || session?.currentSession?.access_token || '',
      };
    } catch {
      return { config, token: '' };
    }
  }

  function authHeaders(config, token, json = false) {
    const headers = {
      apikey: config.apiKey,
      Authorization: `Bearer ${token}`,
    };
    if (json) headers['Content-Type'] = 'application/json';
    return headers;
  }

  async function findSchoolId(schoolName, config, token) {
    const url = new URL(`${config.url}/rest/v1/schools`);
    url.searchParams.set('select', 'id,name');
    url.searchParams.set('name', `eq.${schoolName}`);
    const response = await fetch(url, {
      method: 'GET',
      headers: authHeaders(config, token),
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('تعذر التحقق من سجل المدرسة.');
    const schools = await response.json();
    const exact = Array.isArray(schools)
      ? schools.find((school) => school?.name === schoolName)
      : null;
    if (!exact?.id) throw new Error('تعذر العثور على المدرسة المحددة.');
    return exact.id;
  }

  function showError(modal, message) {
    let box = modal.querySelector('.delete-with-history-error');
    if (!box) {
      box = document.createElement('div');
      box.className = 'dashboard-error delete-with-history-error';
      const actions = modal.querySelector('.lifecycle-actions');
      if (actions) actions.before(box);
      else modal.appendChild(box);
    }
    box.textContent = message;
  }

  async function deleteSchoolWithHistory(modal, button) {
    const schoolName = modal.querySelector('.modal-heading h2')?.textContent?.trim() || '';
    if (!schoolName) {
      showError(modal, 'تعذر تحديد اسم المدرسة. أغلق النافذة وافتحها من جديد.');
      return;
    }

    const entered = window.prompt(
      `تحذير: سيؤدي هذا الإجراء إلى حذف المدرسة وترخيصها وجميع سجلات أجهزتها نهائيًا.\n\nللتأكيد اكتب اسم المدرسة كاملًا:\n${schoolName}`,
    );
    if (entered !== schoolName) {
      showError(modal, 'لم يتطابق اسم المدرسة، لذلك لم يُنفذ الحذف.');
      return;
    }

    const originalHtml = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<strong>جارٍ حذف المدرسة...</strong><span>يرجى عدم إغلاق الصفحة حتى اكتمال العملية.</span>';

    try {
      const { config, token } = await getAccessToken();
      if (!token) throw new Error('انتهت جلسة الدخول. أعد تسجيل الدخول ثم حاول مرة أخرى.');

      const schoolId = await findSchoolId(schoolName, config, token);
      const response = await fetch(`${config.url}/functions/v1/manage-school-license`, {
        method: 'POST',
        headers: authHeaders(config, token, true),
        body: JSON.stringify({ schoolId, action: 'delete_with_history' }),
        cache: 'no-store',
      });

      let body = null;
      try { body = await response.json(); } catch { /* no-op */ }

      if (!response.ok || !body?.ok) {
        throw new Error(body?.message || 'تعذر حذف المدرسة وسجلات أجهزتها.');
      }

      window.alert(`تم حذف «${schoolName}» وجميع سجلات أجهزتها بنجاح.`);
      window.location.reload();
    } catch (error) {
      showError(modal, error instanceof Error ? error.message : 'تعذر حذف المدرسة وسجلات أجهزتها.');
      button.disabled = false;
      button.innerHTML = originalHtml;
    }
  }

  function enhanceModal(modal) {
    const lifecycleActions = modal.querySelector('.lifecycle-actions');
    const hasDeviceHistory = Boolean(modal.querySelector('.devices-list article'));
    if (!lifecycleActions || !hasDeviceHistory) return;
    if (modal.querySelector(`[${PATCH_ATTRIBUTE}]`)) return;

    const oldDeleteButton = Array.from(lifecycleActions.querySelectorAll('button.danger'))
      .find((button) => button.querySelector('strong')?.textContent?.trim() === 'حذف المدرسة نهائيًا');
    if (oldDeleteButton) oldDeleteButton.hidden = true;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'danger';
    button.setAttribute(PATCH_ATTRIBUTE, 'true');
    button.innerHTML = [
      '<strong>حذف المدرسة وجميع أجهزتها</strong>',
      '<span>يحذف الترخيص وسجلات الأجهزة والملفات المرتبطة نهائيًا، مع إبقاء سجل التدقيق.</span>',
    ].join('');
    button.addEventListener('click', () => void deleteSchoolWithHistory(modal, button));
    lifecycleActions.appendChild(button);
  }

  function enhanceOpenModals() {
    document.querySelectorAll('.actions-modal').forEach((modal) => enhanceModal(modal));
  }

  const observer = new MutationObserver(enhanceOpenModals);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  enhanceOpenModals();
})();
