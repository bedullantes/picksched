/**
 * Local stand-ins for SendGrid's Mail Send API and Twilio's Messages API, for
 * tests. They check authentication, record what was sent, and can simulate
 * outages, slow responses and rejected numbers.
 */
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';

export interface SentEmail {
  to: string;
  from: { email: string; name: string };
  subject: string;
  text: string;
  html: string;
  categories: string[];
  customArgs: Record<string, string>;
  receivedAt: number;
}

export interface SentSms {
  to: string;
  from?: string;
  messagingServiceSid?: string;
  body: string;
  statusCallback?: string;
  sid: string;
  receivedAt: number;
}

export async function startFakeMessaging(opts: { sendgridKey: string; twilioSid: string; twilioToken: string; port?: number }) {
  const emails: SentEmail[] = [];
  const sms: SentSms[] = [];
  const state = {
    /** HTTP status SendGrid answers with (202 = accepted). */
    sendgridStatus: 202,
    /** HTTP status Twilio answers with (201 = created); errorCode for 4xx. */
    twilioStatus: 201,
    twilioErrorCode: 21211,
    delayMs: 0,
  };

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(async (_req, _res, next) => {
    if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
    next();
  });

  app.post('/v3/mail/send', (req, res) => {
    if (req.get('Authorization') !== `Bearer ${opts.sendgridKey}`) {
      return void res.status(401).json({ errors: [{ message: 'The provided authorization grant is invalid.' }] });
    }
    if (state.sendgridStatus !== 202) {
      return void res.status(state.sendgridStatus).json({ errors: [{ message: 'Simulated SendGrid error' }] });
    }
    const b = req.body;
    const html = b.content.find((c: any) => c.type === 'text/html')?.value;
    const text = b.content.find((c: any) => c.type === 'text/plain')?.value;
    emails.push({
      to: b.personalizations[0].to[0].email, from: b.from, subject: b.subject, text, html,
      categories: b.categories, customArgs: b.personalizations[0].custom_args, receivedAt: Date.now(),
    });
    res.status(202).set('X-Message-Id', `sg_${randomBytes(8).toString('hex')}`).end();
  });

  app.post('/2010-04-01/Accounts/:sid/Messages.json', (req, res) => {
    const expected = `Basic ${Buffer.from(`${opts.twilioSid}:${opts.twilioToken}`).toString('base64')}`;
    if (req.params.sid !== opts.twilioSid || req.get('Authorization') !== expected) {
      return void res.status(401).json({ code: 20003, message: 'Authenticate', status: 401 });
    }
    if (state.twilioStatus !== 201) {
      return void res.status(state.twilioStatus).json({
        code: state.twilioStatus < 500 ? state.twilioErrorCode : 20500,
        message: state.twilioStatus < 500 ? "The 'To' number is not a valid phone number." : 'Internal Server Error',
        status: state.twilioStatus,
      });
    }
    const sid = `SM${randomBytes(16).toString('hex')}`;
    sms.push({
      to: req.body.To, from: req.body.From, messagingServiceSid: req.body.MessagingServiceSid, body: req.body.Body,
      statusCallback: req.body.StatusCallback, sid, receivedAt: Date.now(),
    });
    res.status(201).json({ sid, status: 'queued', to: req.body.To, body: req.body.Body });
  });

  // Inspection page for local development: what would have been sent.
  app.get('/_sent', (_req, res) => res.json({ emails, sms }));
  // Test control: simulate provider responses from another process (end-to-end tests).
  app.post('/_control', (req, res) => {
    for (const k of ['sendgridStatus', 'twilioStatus', 'twilioErrorCode', 'delayMs'] as const) {
      if (typeof req.body?.[k] === 'number') state[k] = req.body[k];
    }
    res.json(state);
  });

  const server = app.listen(opts.port ?? 0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    baseUrl, emails, sms, state,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
