import { Router, type Request, type Response } from 'express';
import { createLogger } from '../../../platform/core/logger';
import { recordLead } from '../services/marketing-leads';

const logger = createLogger('CONTACT');

const router = Router();

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/contact', async (req: Request, res: Response) => {
  const { name, email, company, message } = req.body ?? {};

  if (!name || !email || !message) {
    res.status(400).json({ error: 'Name, email, and message are required' });
    return;
  }
  if (!emailRegex.test(email)) {
    res.status(400).json({ error: 'Invalid email address' });
    return;
  }

  logger.info('Contact form submission received', {
    name,
    email,
    company: company || '(not provided)',
    messageLength: String(message).length,
  });

  await recordLead({
    source: 'contact',
    name,
    email,
    company: company || null,
    payload: { message },
  });

  res.json({ success: true, message: 'Your message has been received. We will get back to you shortly.' });
});

router.post('/book-demo', async (req: Request, res: Response) => {
  const { name, email, company, phone, teamSize, useCase, preferredTime } = req.body ?? {};

  if (!name || !email || !company) {
    res.status(400).json({ error: 'Name, email, and company are required' });
    return;
  }
  if (!emailRegex.test(email)) {
    res.status(400).json({ error: 'Invalid email address' });
    return;
  }

  await recordLead({
    source: 'book_demo',
    name,
    email,
    company,
    phone: phone || null,
    payload: { teamSize, useCase, preferredTime },
  });

  res.json({
    success: true,
    message: 'Demo request received. Pick a time on the calendar to confirm your slot.',
  });
});

router.post('/roi-lead', async (req: Request, res: Response) => {
  const { email, name, company, results, inputs, vertical } = req.body ?? {};

  if (!email || !emailRegex.test(email)) {
    res.status(400).json({ error: 'A valid email is required' });
    return;
  }

  await recordLead({
    source: 'roi_calculator',
    email,
    name: name || null,
    company: company || null,
    payload: { results, inputs, vertical },
  });

  res.json({
    success: true,
    message: 'Your ROI report is on its way. Check your inbox shortly.',
  });
});

export default router;
