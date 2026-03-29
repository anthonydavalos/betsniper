import express from 'express';
import {
  preparePinnacleSemiAutoTicket,
  confirmPinnacleSemiAutoTicket,
  cancelPinnacleSemiAutoTicket,
  getPinnacleSemiAutoTickets,
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
