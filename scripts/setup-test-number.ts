import 'dotenv/config';
import { getPlatformPool, withTenantContext, withPrivilegedClient } from '../platform/db';
import { randomUUID } from 'crypto';

const AGENT_NAME = 'Quality Voice Operations Agent';
const PHONE_NUMBER = '+16263821543';
const TENANT_ID = 'admin-org';

async function main() {
  console.log('=== Setting up test number for admin-org tenant ===\n');

  const devDomain = process.env.REPLIT_DEV_DOMAIN;
  if (!devDomain) {
    console.error('ERROR: REPLIT_DEV_DOMAIN is not set');
    process.exit(1);
  }

  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL row_security = off`);

    const { rows: existingAgents } = await client.query(
      `SELECT id FROM agents WHERE tenant_id = $1 AND name = $2 LIMIT 1`,
      [TENANT_ID, AGENT_NAME],
    );

    let agentId: string;
    if (existingAgents.length > 0) {
      agentId = existingAgents[0].id as string;
      console.log(`Agent already exists: ${agentId}`);
    } else {
      agentId = randomUUID();
      await client.query(
        `INSERT INTO agents (id, tenant_id, name, type, status, voice, model, system_prompt, welcome_greeting)
         VALUES ($1, $2, $3, 'answering-service', 'active', 'sage', 'gpt-4o-realtime-preview',
           'You are a professional answering service agent for Quality Voice Operations. You are friendly, helpful, and professional. You answer calls, take messages, and help callers with their inquiries. Always greet the caller warmly and ask how you can help them today.',
           'Hello, thank you for calling Quality Voice Operations. How can I help you today?')`,
        [agentId, TENANT_ID, AGENT_NAME],
      );
      console.log(`Agent created: ${agentId}`);
    }

    const { rows: existingNumbers } = await client.query(
      `SELECT id FROM phone_numbers WHERE tenant_id = $1 AND phone_number = $2 LIMIT 1`,
      [TENANT_ID, PHONE_NUMBER],
    );

    let phoneNumberId: string;
    if (existingNumbers.length > 0) {
      phoneNumberId = existingNumbers[0].id as string;
      console.log(`Phone number already exists: ${phoneNumberId}`);
    } else {
      phoneNumberId = randomUUID();
      await client.query(
        `INSERT INTO phone_numbers (id, tenant_id, phone_number, friendly_name, provider, status, capabilities)
         VALUES ($1, $2, $3, 'Test Number', 'twilio', 'active', '{"voice":true,"sms":true}')`,
        [phoneNumberId, TENANT_ID, PHONE_NUMBER],
      );
      console.log(`Phone number registered: ${phoneNumberId}`);
    }

    const { rows: existingRoutes } = await client.query(
      `SELECT id FROM number_routing WHERE phone_number_id = $1 LIMIT 1`,
      [phoneNumberId],
    );

    if (existingRoutes.length > 0) {
      await client.query(
        `UPDATE number_routing SET agent_id = $1, is_active = true WHERE phone_number_id = $2`,
        [agentId, phoneNumberId],
      );
      console.log(`Routing updated to agent ${agentId}`);
    } else {
      await client.query(
        `INSERT INTO number_routing (id, tenant_id, phone_number_id, agent_id, priority, is_active)
         VALUES ($1, $2, $3, $4, 1, true)`,
        [randomUUID(), TENANT_ID, phoneNumberId, agentId],
      );
      console.log(`Routing created for agent ${agentId}`);
    }

    await client.query('COMMIT');
    console.log('\nDB setup complete.');

    if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
      console.log('\n--- Updating Twilio webhook URLs ---');
      const twilio = require('twilio');
      const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

      const webhookUrl = `https://${devDomain}/twilio/voice`;
      const statusUrl = `https://${devDomain}/twilio/status`;

      const numbers = await twilioClient.incomingPhoneNumbers.list({ phoneNumber: PHONE_NUMBER });
      if (numbers.length === 0) {
        console.error(`Phone number ${PHONE_NUMBER} not found in Twilio account`);
      } else {
        await twilioClient.incomingPhoneNumbers(numbers[0].sid).update({
          voiceUrl: webhookUrl,
          voiceMethod: 'POST',
          statusCallback: statusUrl,
          statusCallbackMethod: 'POST',
        });
        console.log(`Voice URL: ${webhookUrl}`);
        console.log(`Status callback: ${statusUrl}`);
        console.log('Twilio webhook URLs updated.');
      }
    } else {
      console.log('\nSkipping Twilio webhook update (no credentials)');
    }

    console.log('\n=== Setup complete ===');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Setup failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
