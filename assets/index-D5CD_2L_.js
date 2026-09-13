import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

type LifecycleAction =
  | "rotate_code"
  | "rotate_credentials"
  | "suspend"
  | "resume"
  | "revoke"
  | "archive"
  | "delete_unused"
  | "delete_with_history"
  | "release_device";

type LifecycleRequest = {
  schoolId?: unknown;
  action?: unknown;
  deviceId?: unknown;
  reason?: unknown;
};

const allowedActions = new Set<LifecycleAction>([
  "rotate_code", "rotate_credentials", "suspend", "resume", "revoke", "archive", "delete_unused", "delete_with_history", "release_device",
]);

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const passwordAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";

function response(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function randomPart(length: number) {
  const values = new Uint32Array(length);
  crypto.getRandomValues(values);
  return Array.from(values).map((value) => alphabet[value % alphabet.length]).join("");
}

function activationCode() {
  return ["SRS", randomPart(4), randomPart(4), randomPart(4), randomPart(4)].join("-");
}

function temporaryPassword() {
  const values = new Uint32Array(14);
  crypto.getRandomValues(values);
  return Array.from(values).map((value) => passwordAlphabet[value % passwordAlphabet.length]).join("");
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return response({ ok: false, message: "هذه الوظيفة تقبل POST فقط." }, 405);

  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return response({ ok: false, message: "يجب تسجيل الدخول بحساب مدير النظام." }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return response({ ok: false, message: "إعدادات الخادم غير مكتملة." }, 500);
  }

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const token = authorization.slice("Bearer ".length).trim();
  const { data: { user }, error: userError } = await client.auth.getUser(token);
  if (userError || !user) return response({ ok: false, message: "جلسة الدخول غير صالحة أو انتهت." }, 401);
  const { data: profile } = await client.from("admin_profiles")
    .select("is_system_admin, is_active").eq("user_id", user.id).maybeSingle();
  if (!profile?.is_system_admin || !profile?.is_active) {
    return response({ ok: false, message: "ليس لديك صلاحية إدارة التراخيص." }, 403);
  }

  let body: LifecycleRequest;
  try { body = await request.json() as LifecycleRequest; }
  catch { return response({ ok: false, message: "بيانات الطلب غير صالحة." }, 400); }

  const schoolId = typeof body.schoolId === "string" ? body.schoolId.trim() : "";
  const action = typeof body.action === "string" ? body.action.trim().toLowerCase() as LifecycleAction : null;
  if (!isUuid(schoolId) || !action || !allowedActions.has(action)) {
    return response({ ok: false, message: "المدرسة أو الإجراء غير صالح." }, 400);
  }

  if (action === "release_device") {
    const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
    if (!isUuid(deviceId)) {
      return response({ ok: false, message: "معرّف الجهاز غير صالح." }, 400);
    }

    const { data, error } = await client.rpc("release_license_device", {
      p_admin_user_id: user.id,
      p_device_id: deviceId,
      p_reason: reason || "إعادة تثبيت البرنامج أو تهيئة الجهاز",
    });

    if (error || !data?.[0]) {
      console.error("Device release failed", { code: error?.code, message: error?.message });
      const message = error?.message?.includes("DEVICE_NOT_ACTIVE")
        ? "الجهاز مفصول مسبقًا."
        : error?.message?.includes("DEVICE_NOT_FOUND")
          ? "لم يتم العثور على الجهاز."
          : "تعذر فك ارتباط الجهاز.";
      return response({ ok: false, message }, 400);
    }

    return response({ ok: true, action, result: data[0] });
  }

  if (action === "rotate_credentials") {
    const { data: school, error: schoolError } = await client.from("schools")
      .select("login_username, credentials_revision").eq("id", schoolId).single();
    if (schoolError || !school) return response({ ok: false, message: "تعذر العثور على المدرسة." }, 404);
    const username = String(school.login_username ?? "").trim();
    if (!username) return response({ ok: false, message: "يجب تحديد اسم المستخدم الثابت للمدرسة أولًا." }, 400);
    const password = temporaryPassword();
    const passwordHash = await sha256(password);
    const revision = Number(school.credentials_revision ?? 0) + 1;
    const { error: updateError } = await client.from("schools").update({
      login_password_hash: passwordHash,
      credentials_revision: revision,
      credentials_updated_at: new Date().toISOString(),
    }).eq("id", schoolId);
    if (updateError) return response({ ok: false, message: "تعذر إصدار بيانات الدخول الجديدة." }, 500);
    return response({
      ok: true,
      action,
      credentials: { username, temporaryPassword: password, mustChange: true, revision },
      warning: "احفظ كلمة المرور الآن؛ لن تظهر مرة أخرى.",
    });
  }

  if (action === "delete_with_history") {
    const { data: school } = await client.from("schools").select("logo_path, stamp_path").eq("id", schoolId).maybeSingle();
    const { data, error } = await client.rpc("delete_school_completely", { p_admin_user_id: user.id, p_school_id: schoolId });
    if (error || !data?.[0]) {
      console.error("Complete school deletion failed", { code: error?.code, message: error?.message });
      return response({ ok: false, message: "تعذر حذف المدرسة وسجلات أجهزتها." }, 400);
    }
    const storedFiles = [school?.logo_path, school?.stamp_path].filter((path): path is string => typeof path === "string" && path.length > 0);
    if (storedFiles.length) await client.storage.from("school-logos").remove(storedFiles);
    return response({ ok: true, action, result: data[0] });
  }

  let plainCode: string | null = null;
  let codeHash: string | null = null;
  let codeLast4: string | null = null;
  if (action === "rotate_code") {
    plainCode = activationCode();
    codeHash = await sha256(plainCode.toUpperCase());
    codeLast4 = plainCode.slice(-4);
  }

  const { data, error } = await client.rpc("manage_school_license_lifecycle", {
    p_admin_user_id: user.id,
    p_school_id: schoolId,
    p_action: action,
    p_activation_code_hash: codeHash,
    p_activation_code_last4: codeLast4,
  });

  if (error || !data?.[0]) {
    console.error("Lifecycle operation failed", { action, code: error?.code, message: error?.message });
    const messages: Record<string, string> = {
      SCHOOL_HAS_DEVICE_HISTORY: "لا يمكن حذف مدرسة لديها سجل أجهزة. استخدم الأرشفة.",
      LICENSE_EXPIRED: "لا يمكن استئناف ترخيص منتهي. يجب تجديده أولًا.",
      LICENSE_REVOKED: "الترخيص ملغي نهائيًا ولا يمكن إصدار كود بديل له.",
      LICENSE_NOT_ACTIVE: "الترخيص ليس نشطًا حاليًا.",
      LICENSE_NOT_SUSPENDED: "الترخيص ليس معلقًا حاليًا.",
    };
    const matched = Object.keys(messages).find((key) => error?.message?.includes(key));
    return response({ ok: false, message: matched ? messages[matched] : "تعذر تنفيذ الإجراء المطلوب." }, 400);
  }

  return response({
    ok: true,
    action,
    result: data[0],
    activationCode: plainCode,
    warning: plainCode ? "احفظ كود التفعيل الجديد الآن؛ لن يظهر كاملًا مرة أخرى." : null,
  });
});
