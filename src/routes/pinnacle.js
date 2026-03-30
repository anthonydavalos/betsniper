import express from 'express';
import {
  preparePinnacleSemiAutoTicket,
  confirmPinnacleSemiAutoTicket,
  cancelPinnacleSemiAutoTicket,
  getPinnacleSemiAutoTickets,
  getPinnacleAccountBalance,
  getPinnacleAccountSnapshot,
  syncRemotePinnacleHistory,
  getLatestPinnacleCapture,
  getPinnacleRealPlacementDryRun,
  confirmPinnacleRealPlacement,
  confirmPinnacleRealPlacementFast
} from '../services/pinnacleSemiAutoService.js';

const router = express.Router();

const sendPinnacleError = (res, error, fallbackStatus = 400) => {
  const status = Number(error?.statusCode) || fallbackStatus;
  const payload = {
    success: false,
    message: error?.message || 'Error inesperado en Pinnacle.'
  };

  if (error?.code) payload.code = error.code;
  if (error?.diagnostic) payload.diagnostic = error.diagnostic;

  return res.status(status).json(payload);
};

// GET /api/pinnacle/tickets
router.get('/tickets', async (_req, res) => {
  try {
    const data = await getPinnacleSemiAutoTickets();
    res.json({ success: true, ...data });
  } catch (error) {
    sendPinnacleError(res, error, 500);
  }
});

// GET /api/pinnacle/account
router.get('/account', async (req, res) => {
  try {
    const refresh = String(req.query?.refresh || '').toLowerCase();
    const forceRefresh = refresh === '1' || refresh === 'true' || refresh === 'yes';

    const historyLimitRaw = Number(req.query?.historyLimit);
    const historyLimit = Number.isFinite(historyLimitRaw)
      ? (historyLimitRaw <= 0 ? 0 : Math.max(1, Math.min(5000, Math.floor(historyLimitRaw))))
      : 0;

    const historyStatus = String(req.query?.historyStatus || '').trim() || null;
    const historyDaysRaw = Number(req.query?.historyDays);
    const historyDays = Number.isFinite(historyDaysRaw) && historyDaysRaw > 0
      ? Math.floor(historyDaysRaw)
      : null;

    const data = historyLimit > 0 || forceRefresh
      ? await getPinnacleAccountSnapshot({
        forceRefresh,
        historyLimit,
        historyStatus: historyStatus || undefined,
        historyDays: historyDays || undefined
      })
      : await getPinnacleAccountBalance();

    res.json({ success: true, ...data });
  } catch (error) {
    sendPinnacleError(res, error, 500);
  }
});

// GET /api/pinnacle/history?refresh=1&limit=200&status=settled&days=120
router.get('/history', async (req, res) => {
  try {
    const refresh = String(req.query?.refresh || '').toLowerCase();
    const forceRefresh = refresh === '1' || refresh === 'true' || refresh === 'yes';

    const limitRaw = Number(req.query?.limit || 200);
    const limit = Number.isFinite(limitRaw)
      ? (limitRaw <= 0 ? 0 : Math.max(1, Math.min(5000, Math.floor(limitRaw))))
      : 200;

    const status = String(req.query?.status || '').trim() || undefined;
    const daysRaw = Number(req.query?.days);
    const days = Number.isFinite(daysRaw) && daysRaw > 0
      ? Math.floor(daysRaw)
      : undefined;

    const data = await syncRemotePinnacleHistory({
      forceRefresh,
      limit,
      status,
      days
    });

    res.json({ success: true, ...data });
  } catch (error) {
    sendPinnacleError(res, error, 500);
  }
});

// GET /api/pinnacle/capture/latest
router.get('/capture/latest', async (_req, res) => {
  try {
    const data = await getLatestPinnacleCapture();
    res.json({ success: true, ...data });
  } catch (error) {
    sendPinnacleError(res, error, 500);
  }
});

// POST /api/pinnacle/prepare
router.post('/prepare', async (req, res) => {
  try {
    const ticket = await preparePinnacleSemiAutoTicket(req.body || {});
    res.json({ success: true, ticket });
  } catch (error) {
    sendPinnacleError(res, error, 400);
  }
});

// POST /api/pinnacle/confirm/:id
router.post('/confirm/:id', async (req, res) => {
  try {
    const result = await confirmPinnacleSemiAutoTicket(req.params.id);
    res.json({ success: true, ...result });
  } catch (error) {
    sendPinnacleError(res, error, 400);
  }
});

// POST /api/pinnacle/cancel/:id
router.post('/cancel/:id', async (req, res) => {
  try {
    const ticket = await cancelPinnacleSemiAutoTicket(req.params.id);
    res.json({ success: true, ticket });
  } catch (error) {
    sendPinnacleError(res, error, 400);
  }
});

// POST /api/pinnacle/real/dryrun/:id
router.post('/real/dryrun/:id', async (req, res) => {
  try {
    const draft = await getPinnacleRealPlacementDryRun(req.params.id);
    res.json({ success: true, draft });
  } catch (error) {
    sendPinnacleError(res, error, 400);
  }
});

// POST /api/pinnacle/real/confirm/:id
router.post('/real/confirm/:id', async (req, res) => {
  try {
    const result = await confirmPinnacleRealPlacement(req.params.id);
    res.json({ success: true, ...result });
  } catch (error) {
    sendPinnacleError(res, error, 400);
  }
});

// POST /api/pinnacle/real/confirm-fast/:id
router.post('/real/confirm-fast/:id', async (req, res) => {
  try {
    const result = await confirmPinnacleRealPlacementFast(req.params.id);
    res.json({ success: true, ...result });
  } catch (error) {
    sendPinnacleError(res, error, 400);
  }
});

export default router;
