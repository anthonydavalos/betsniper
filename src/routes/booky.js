import express from 'express';
import {
  prepareSemiAutoTicket,
  confirmSemiAutoTicket,
  cancelSemiAutoTicket,
  getSemiAutoTickets,
  getBookyTokenHealth,
  requestBookyTokenRenewal,
  getLatestBookyCapture,
  getRealPlacementDryRun,
  confirmRealPlacement,
  confirmRealPlacementFast
} from '../services/bookySemiAutoService.js';
import { getBookyAccountSnapshot } from '../services/bookyAccountService.js';

const router = express.Router();

const sendBookyError = (res, error, fallbackStatus = 400) => {
  const status = Number(error?.statusCode) || fallbackStatus;
  const payload = {
    success: false,
    message: error?.message || 'Error inesperado en Booky.'
  };

  if (error?.code) payload.code = error.code;
  if (error?.diagnostic) payload.diagnostic = error.diagnostic;

  return res.status(status).json(payload);
};

// GET /api/booky/tickets
router.get('/tickets', async (req, res) => {
  try {
    const data = await getSemiAutoTickets();
    res.json({ success: true, ...data });
  } catch (error) {
    sendBookyError(res, error, 500);
  }
});

// GET /api/booky/capture/latest
router.get('/capture/latest', async (req, res) => {
  try {
    const data = await getLatestBookyCapture();
    res.json({ success: true, ...data });
  } catch (error) {
    sendBookyError(res, error, 500);
  }
});

// GET /api/booky/token-health
router.get('/token-health', async (req, res) => {
  try {
    const data = getBookyTokenHealth();
    res.json({ success: true, token: data });
  } catch (error) {
    sendBookyError(res, error, 500);
  }
});

// GET /api/booky/account?refresh=1&historyLimit=60
router.get('/account', async (req, res) => {
  try {
    const refresh = String(req.query?.refresh || '').toLowerCase();
    const forceRefresh = refresh === '1' || refresh === 'true' || refresh === 'yes';
    const historyLimit = Number(req.query?.historyLimit || 60);
    const cleanup = String(req.query?.cleanup || '').toLowerCase();
    const cleanupOld = cleanup === '1' || cleanup === 'true' || cleanup === 'yes';
    const retentionDaysRaw = Number(req.query?.retentionDays);
    const retentionDays = Number.isFinite(retentionDaysRaw) && retentionDaysRaw > 0
      ? retentionDaysRaw
      : null;

    const data = await getBookyAccountSnapshot({
      forceRefresh,
      historyLimit,
      cleanupOld,
      retentionDays
    });
    res.json({ success: true, ...data });
  } catch (error) {
    sendBookyError(res, error, 500);
  }
});

// POST /api/booky/token/renew
router.post('/token/renew', async (req, res) => {
  try {
    const data = requestBookyTokenRenewal();
    res.json({ success: true, ...data });
  } catch (error) {
    sendBookyError(res, error, 500);
  }
});

// POST /api/booky/prepare
router.post('/prepare', async (req, res) => {
  try {
    const opportunity = req.body;
    const ticket = await prepareSemiAutoTicket(opportunity);
    res.json({ success: true, ticket });
  } catch (error) {
    sendBookyError(res, error, 400);
  }
});

// POST /api/booky/confirm/:id
router.post('/confirm/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await confirmSemiAutoTicket(id);
    res.json({ success: true, ...result });
  } catch (error) {
    sendBookyError(res, error, 400);
  }
});

// POST /api/booky/cancel/:id
router.post('/cancel/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const ticket = await cancelSemiAutoTicket(id);
    res.json({ success: true, ticket });
  } catch (error) {
    sendBookyError(res, error, 400);
  }
});

// POST /api/booky/real/dryrun/:id
router.post('/real/dryrun/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const draft = await getRealPlacementDryRun(id);
    res.json({ success: true, draft });
  } catch (error) {
    sendBookyError(res, error, 400);
  }
});

// POST /api/booky/real/confirm/:id
router.post('/real/confirm/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await confirmRealPlacement(id);
    res.json({ success: true, ...result });
  } catch (error) {
    sendBookyError(res, error, 400);
  }
});

// POST /api/booky/real/confirm-fast/:id
router.post('/real/confirm-fast/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await confirmRealPlacementFast(id);
    res.json({ success: true, ...result });
  } catch (error) {
    sendBookyError(res, error, 400);
  }
});

export default router;
