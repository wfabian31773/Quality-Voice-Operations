import { Router, type Request, type Response } from 'express';
import { createLogger } from '../../../platform/core/logger';

const logger = createLogger('CONTACT');

const router = Router();

router.post('/contact', (req: Request, res: Response) => {
  const { name, email, company, message } = req.body ?? {};

  if (!name || !email || !message) {
    res.status(400).json({ error: 'Name, email, and message are required' });
    return;
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    res.status(400).json({ error: 'Invalid email address' });
    return;
  }

  logger.info('Contact form submission received', {
    name,
    email,
    company: company || '(not provided)',
    messageLength: message.length,
  });

  res.json({ success: true, message: 'Your message has been received. We will get back to you shortly.' });
});

export default router;
