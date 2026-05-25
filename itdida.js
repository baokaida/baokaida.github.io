// 易抵达 (itdida) API v2.2 - 2026-05-25
// 变更 (基于 v2.1):
// 1. POST /quote 接受可选的 targetEmail body 参数
//    如果调用者是 admin (bkd@baokaida.com),会用 targetEmail 的 markup 而不是 admin 自己的
//    普通用户传 targetEmail 会被忽略 (用自己的 markup)
// 2. admin 用 targetEmail 调用时,不写 customer_activity 日志 (避免污染活跃度数据)
const express = require('express');
const axios = require('axios');
const { admin, auth, db } = require('../lib/firebase');

const router = express.Router();

const FALLBACK_WORKER = 'https://bkd-itdida-proxy.bkd-666.workers.dev';
const ADMIN_EMAILS = ['bkd@baokaida.com'];

function isAdminEmail(email) {
  if (!email) return false;
  return ADMIN_EMAILS.indexOf(String(email).trim().toLowerCase()) >= 0;
}

/**
 * 从 Bearer token 解出 uid+email,再查 Firestore 拿 markup
 * 如果调用者是 admin 且传了 targetEmail,改用 targetEmail 对应的 markup
 * 返回:
 *   { uid, email, markup, isAdminOverride }
 *   或 null (未登录/token无效)
 */
async function getMarkupFromToken(authHeader, targetEmail) {
  if (!authHeader) return null;
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  if (!token) return null;

  try {
    const decoded = await auth.verifyIdToken(token);
    const uid = decoded.uid;
    const callerEmail = decoded.email;

    // admin override: caller 是 admin 且传了 targetEmail
    if (targetEmail && isAdminEmail(callerEmail)) {
      // 用 targetEmail 查 Firestore users 集合拿 markup
      const targetEmailLower = String(targetEmail).trim().toLowerCase();
      const userQuery = await db.collection('users')
        .where('email', '==', targetEmailLower)
        .limit(1)
        .get();

      let targetMarkup = null;
      let targetUid = null;
      if (!userQuery.empty) {
        const doc = userQuery.docs[0];
        targetUid = doc.id;
        targetMarkup = doc.data()?.markup ?? null;
      }

      return {
        uid: targetUid || uid,
        email: targetEmailLower,
        markup: targetMarkup,
        isAdminOverride: true,
        callerEmail,
      };
    }

    // 正常路径:用 caller 自己的 markup
    const doc = await db.collection('users').doc(uid).get();
    if (!doc.exists) {
      return { uid, email: callerEmail, markup: null, isAdminOverride: false };
    }

    const data = doc.data();
    return {
      uid,
      email: callerEmail,
      markup: data?.markup ?? null,
      isAdminOverride: false,
    };
  } catch (e) {
    return null;
  }
}

/**
 * 写一条 customer_activity 日志 - 严格 try-catch,绝不能影响主流程
 * admin override 模式下不写日志
 */
async function logQuoteActivity(authResult, body, channelCount, req) {
  if (!authResult || !authResult.uid) return; // 匿名访客不记录
  if (authResult.isAdminOverride) return;       // admin 代查不记录 (避免污染)
  try {
    await db.collection('customer_activity').add({
      uid: authResult.uid,
      email: authResult.email || '',
      eventType: 'quote',
      countryCode: body.countryCode || '',
      countryCn: body.countryCn || '',
      weight: Number(body.weight) || 0,
      pieceCount: Number(body.pieceCount) || 1,
      channelCount: Number(channelCount) || 0,
      markup: authResult.markup ?? null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      userAgent: req.headers['user-agent'] || '',
    });
  } catch (e) {
    console.warn('[activity log] failed:', e.message);
  }
}

/**
 * POST /api/itdida/quote
 * Body 支持的字段:
 *   - countryCode, weight, pieceCount, countryCn, email (原有)
 *   - targetEmail (新: 仅 admin 生效,代表"我想用这个客户的 markup 查价")
 */
router.post('/quote', async (req, res) => {
  try {
    const body = { ...(req.body || {}) };
    const targetEmail = body.targetEmail; // 取出来,不要传给 Worker
    delete body.targetEmail;

    const authResult = await getMarkupFromToken(req.headers.authorization, targetEmail);

    if (authResult && authResult.email) {
      body.email = authResult.email;
    }

    const forwardHeaders = { 'Content-Type': 'application/json' };
    if (authResult && authResult.markup !== null && authResult.markup !== undefined) {
      forwardHeaders['X-BKDLL-Markup'] = String(authResult.markup);
      const tag = authResult.isAdminOverride ? '[admin→' + (authResult.callerEmail || '?') + ']' : '';
      console.log('[itdida/quote]' + tag + ' email=' + authResult.email + ' markup=' + authResult.markup);
    } else if (authResult && authResult.email) {
      console.log('[itdida/quote] email=' + authResult.email + ' markup=未设定,走Worker fallback');
    }

    const resp = await axios.post(FALLBACK_WORKER + '/quote', body, {
      headers: forwardHeaders,
      timeout: 15000,
    });

    let channelCount = 0;
    const data = resp.data;
    if (data) {
      if (Array.isArray(data.data)) channelCount = data.data.length;
      else if (Array.isArray(data.list)) channelCount = data.list.length;
      else if (Array.isArray(data.channels)) channelCount = data.channels.length;
      else if (Array.isArray(data)) channelCount = data.length;
    }

    res.json(resp.data);
    logQuoteActivity(authResult, body, channelCount, req).catch(e => {
      console.warn('[activity log outer]', e.message);
    });
    return;
  } catch (err) {
    console.error('[itdida/quote] error:', (err.response && err.response.data) || err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/info', async (req, res) => {
  try {
    const resp = await axios.get(FALLBACK_WORKER + '/info', { timeout: 10000 });
    return res.json(resp.data);
  } catch (err) {
    console.error('[itdida/info] error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/track/:num', async (req, res) => {
  const num = req.params.num;
  try {
    const resp = await axios.get(FALLBACK_WORKER + '/track/' + encodeURIComponent(num), { timeout: 15000 });
    return res.json(resp.data);
  } catch (err) {
    console.error('[itdida/track] error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
