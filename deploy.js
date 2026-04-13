// Sova Deploy — Retell AI conversation flow agent builder
// Requires Node.js 18+ (native fetch)

const clientConfig = require('./clients/tmw.config');

const RETELL_API_KEY = 'key_7ce108b8ae4daed4569ec5fd308d';
const RETELL_BASE_URL = 'https://api.retellai.com';

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------
async function retellPost(endpoint, body) {
  const res = await fetch(`${RETELL_BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RETELL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Retell ${endpoint} → ${res.status}: ${text}`);
  }
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function deploy() {
  const {
    businessName,
    agentName,
    locationId,
    calendars,
    ghlBearerToken,
    bookingWebhookUrl,
    voiceId,
    llmModel,
  } = clientConfig;

  if (bookingWebhookUrl.startsWith('https://YOUR_WEBHOOK_URL')) {
    console.error(
      '\nError: bookingWebhookUrl is not configured.\n' +
      'Set clients/tmw.config.js → bookingWebhookUrl to the endpoint that\n' +
      'receives Retell function calls and creates GHL bookings.\n'
    );
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  // Tool definition (referenced by the function node via tool_id)
  // -------------------------------------------------------------------------
  const ghlBookingTool = {
    type: 'custom',
    tool_id: 'create_ghl_booking',
    name: 'create_ghl_booking',
    description:
      'Creates an appointment booking in GoHighLevel for the caller. ' +
      'Call this after all required information has been collected.',
    url: bookingWebhookUrl,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ghlBearerToken}`,
      'Content-Type': 'application/json',
    },
    speak_during_execution: false,
    speak_after_execution: false,
    timeout_ms: 30000,
    parameters: {
      type: 'object',
      properties: {
        calendarId: {
          type: 'string',
          description:
            `The GHL calendar ID based on session duration. ` +
            `25 min: ${calendars[25]}, ` +
            `55 min: ${calendars[55]}, ` +
            `85 min: ${calendars[85]}, ` +
            `110 min: ${calendars[110]}`,
        },
        locationId: {
          type: 'string',
          description: `Always use: ${locationId}`,
        },
        startTime: {
          type: 'string',
          description:
            'Appointment start time in ISO 8601 format with timezone offset. ' +
            'Example: 2026-03-28T14:00:00-04:00',
        },
        endTime: {
          type: 'string',
          description:
            'Appointment end time in ISO 8601 format. ' +
            'Calculate by adding session duration in minutes to startTime.',
        },
        firstName: { type: 'string', description: "Caller's first name" },
        lastName: { type: 'string', description: "Caller's last name" },
        email: { type: 'string', description: "Caller's email address" },
        phone: { type: 'string', description: "Caller's phone number" },
        title: {
          type: 'string',
          description:
            'Format: [First Name] [Last Name] - [Service] - [Duration] min',
        },
      },
      required: [
        'calendarId',
        'locationId',
        'startTime',
        'endTime',
        'firstName',
        'lastName',
        'email',
        'phone',
        'title',
      ],
    },
  };

  // -------------------------------------------------------------------------
  // Node definitions
  // -------------------------------------------------------------------------
  const nodes = [

    // 1. Welcome
    {
      id: 'welcome',
      type: 'conversation',
      instruction: {
        type: 'static_text',
        text: `Thank you for calling ${businessName}. This is ${agentName}. How may I help you today?`,
      },
      edges: [
        {
          id: 'welcome_edge',
          transition_condition: {
            type: 'prompt',
            prompt: 'Caller has stated their reason for calling',
          },
          destination_node_id: 'new_or_returning',
        },
      ],
    },

    // 2. New or Returning
    {
      id: 'new_or_returning',
      type: 'conversation',
      instruction: {
        type: 'static_text',
        text: 'Are you a returning client with us, or will this be your first visit?',
      },
      edges: [
        {
          id: 'new_or_returning_edge',
          transition_condition: {
            type: 'prompt',
            prompt: 'Caller has answered whether they are a new or returning client',
          },
          destination_node_id: 'service_type',
        },
      ],
    },

    // 3. Service Type
    {
      id: 'service_type',
      type: 'conversation',
      instruction: {
        type: 'static_text',
        text: 'What type of massage are you looking for?',
      },
      edges: [
        {
          id: 'service_type_edge',
          transition_condition: {
            type: 'prompt',
            prompt: 'Caller has stated their desired service type',
          },
          destination_node_id: 'focus_area',
        },
      ],
    },

    // 4. Focus Area
    {
      id: 'focus_area',
      type: 'conversation',
      instruction: {
        type: 'static_text',
        text: "Is there a particular area you'd like your therapist to focus on, or are you coming in more for general relaxation?",
      },
      edges: [
        {
          id: 'focus_area_edge',
          transition_condition: {
            type: 'prompt',
            prompt: 'Caller has answered about their focus area or stated they want general relaxation',
          },
          destination_node_id: 'session_length',
        },
      ],
    },

    // 5. Session Length
    {
      id: 'session_length',
      type: 'conversation',
      instruction: {
        type: 'prompt',
        text:
          "Reference the caller's focus area and recommend the 85-minute session as the most popular. " +
          "Say something like: \"Most clients coming in for [focus area] tend to prefer the 85-minute session — " +
          "it's our most popular for that. Would that work for you, or were you thinking shorter or longer? " +
          'We have 55, 85, and 110-minute options." Replace [focus area] with what the caller described.',
      },
      edges: [
        {
          id: 'session_length_edge',
          transition_condition: {
            type: 'prompt',
            prompt: 'Caller has confirmed their preferred session duration',
          },
          destination_node_id: 'preferred_day',
        },
      ],
    },

    // 6. Preferred Day
    {
      id: 'preferred_day',
      type: 'conversation',
      instruction: {
        type: 'static_text',
        text: 'What day works best for you?',
      },
      edges: [
        {
          id: 'preferred_day_edge',
          transition_condition: {
            type: 'prompt',
            prompt: 'Caller has stated their preferred day',
          },
          destination_node_id: 'preferred_time',
        },
      ],
    },

    // 7. Preferred Time
    {
      id: 'preferred_time',
      type: 'conversation',
      instruction: {
        type: 'static_text',
        text: 'What time of day works best — morning, afternoon, or do you have a specific time in mind?',
      },
      edges: [
        {
          id: 'preferred_time_edge',
          transition_condition: {
            type: 'prompt',
            prompt: 'Caller has stated their preferred time or time of day',
          },
          destination_node_id: 'therapist_preference',
        },
      ],
    },

    // 8. Therapist Preference
    {
      id: 'therapist_preference',
      type: 'conversation',
      instruction: {
        type: 'static_text',
        text: 'Do you have a preferred therapist, or would you like the first available?',
      },
      edges: [
        {
          id: 'therapist_preference_edge',
          transition_condition: {
            type: 'prompt',
            prompt: 'Caller has answered about therapist preference',
          },
          destination_node_id: 'collect_name',
        },
      ],
    },

    // 9. Collect Name
    {
      id: 'collect_name',
      type: 'conversation',
      instruction: {
        type: 'prompt',
        text:
          'Ask for the caller\'s full name. Say: "Can I get your first and last name?" ' +
          'After they provide their last name, confirm the spelling: ' +
          '"Just to confirm the spelling — is that [last name]?" ' +
          'Wait for them to confirm before proceeding.',
      },
      edges: [
        {
          id: 'collect_name_edge',
          transition_condition: {
            type: 'prompt',
            prompt: "Caller has confirmed the spelling of their last name",
          },
          destination_node_id: 'collect_phone',
        },
      ],
    },

    // 10. Collect Phone
    {
      id: 'collect_phone',
      type: 'conversation',
      instruction: {
        type: 'static_text',
        text: "What's the best phone number for you?",
      },
      edges: [
        {
          id: 'collect_phone_edge',
          transition_condition: {
            type: 'prompt',
            prompt: 'Caller has provided their phone number',
          },
          destination_node_id: 'collect_email',
        },
      ],
    },

    // 11. Collect Email
    {
      id: 'collect_email',
      type: 'conversation',
      instruction: {
        type: 'static_text',
        text: 'And your email address so I can send you the booking link?',
      },
      edges: [
        {
          id: 'collect_email_edge',
          transition_condition: {
            type: 'prompt',
            prompt: 'Caller has provided their email address',
          },
          destination_node_id: 'upsell',
        },
      ],
    },

    // 12. Upsell
    {
      id: 'upsell',
      type: 'conversation',
      instruction: {
        type: 'prompt',
        text:
          "Based on the caller's focus area, offer one relevant add-on:\n" +
          '- Neck, shoulders, or back tension → hot stone add-on ($20)\n' +
          '- Sports recovery → compression therapy 30 min ($40)\n' +
          '- Stress or relaxation → float therapy 60 min ($95)\n\n' +
          'Present the relevant add-on first (if applicable), then always follow with the TMW Experience offer:\n' +
          '"After your session you\'re also welcome to use our relaxation lounge — robes, warm slippers, ' +
          'heated neck wraps, tea. It\'s called the TMW Experience and it\'s just $50 for the day. ' +
          'Would you like to add that?"\n\n' +
          'If the focus area does not match any add-on, go straight to the TMW Experience offer. ' +
          'Present each offer naturally and warmly, one at a time.',
      },
      edges: [
        {
          id: 'upsell_edge',
          transition_condition: {
            type: 'prompt',
            prompt: 'Caller has responded to all upsell offers',
          },
          destination_node_id: 'extract_variables',
        },
      ],
    },

    // 13. Extract Variables
    {
      id: 'extract_variables',
      type: 'extract_dynamic_variables',
      variables: [
        {
          type: 'number',
          name: 'duration',
          description: 'Session duration in minutes chosen by the caller (25, 55, 85, or 110)',
          required: true,
        },
        {
          type: 'string',
          name: 'therapist_preference',
          description: 'Therapist the caller requested, or "first available"',
          required: true,
        },
        {
          type: 'string',
          name: 'preferred_day',
          description: 'Day the caller prefers for the appointment',
          required: true,
        },
        {
          type: 'string',
          name: 'preferred_time',
          description: 'Time or time of day the caller prefers',
          required: true,
        },
        {
          type: 'string',
          name: 'first_name',
          description: "Caller's first name",
          required: true,
        },
        {
          type: 'string',
          name: 'last_name',
          description: "Caller's last name (confirmed spelling)",
          required: true,
        },
        {
          type: 'string',
          name: 'phone',
          description: "Caller's phone number",
          required: true,
        },
        {
          type: 'string',
          name: 'email',
          description: "Caller's email address",
          required: true,
        },
        {
          type: 'string',
          name: 'focus_area',
          description: 'Focus area or massage type described by the caller',
          required: true,
        },
      ],
      else_edge: {
        id: 'extract_else_edge',
        transition_condition: { type: 'prompt', prompt: 'Else' },
        destination_node_id: 'duration_router',
      },
    },

    // 14. Duration Router (branch)
    {
      id: 'duration_router',
      type: 'branch',
      edges: [
        {
          id: 'router_110',
          transition_condition: {
            type: 'equation',
            equations: [{ left: '{{duration}}', operator: '==', right: '110' }],
            operator: '||',
          },
          destination_node_id: 'create_ghl_booking',
        },
        {
          id: 'router_85',
          transition_condition: {
            type: 'equation',
            equations: [{ left: '{{duration}}', operator: '==', right: '85' }],
            operator: '||',
          },
          destination_node_id: 'create_ghl_booking',
        },
        {
          id: 'router_55',
          transition_condition: {
            type: 'equation',
            equations: [{ left: '{{duration}}', operator: '==', right: '55' }],
            operator: '||',
          },
          destination_node_id: 'create_ghl_booking',
        },
        {
          id: 'router_25',
          transition_condition: {
            type: 'equation',
            equations: [{ left: '{{duration}}', operator: '==', right: '25' }],
            operator: '||',
          },
          destination_node_id: 'create_ghl_booking',
        },
      ],
      else_edge: {
        id: 'router_else',
        transition_condition: { type: 'prompt', prompt: 'Else' },
        destination_node_id: 'create_ghl_booking',
      },
    },

    // 15. Create GHL Booking (function node)
    {
      id: 'create_ghl_booking',
      type: 'function',
      tool_id: 'create_ghl_booking',
      tool_type: 'local',
      wait_for_result: true,
      speak_during_execution: true,
      instruction: {
        type: 'static_text',
        text: 'One moment while I get that reserved for you.',
      },
      else_edge: {
        id: 'booking_else_edge',
        transition_condition: { type: 'prompt', prompt: 'Else' },
        destination_node_id: 'send_confirmation',
      },
    },

    // 16. Send Confirmation Link
    {
      id: 'send_confirmation',
      type: 'conversation',
      instruction: {
        type: 'static_text',
        text:
          "You'll get a text in just a moment with a link to finalize everything — just use it to add your card " +
          'and complete your intake form before you come in. Is there anything else I can help you with?',
      },
      edges: [
        {
          id: 'send_confirmation_edge',
          transition_condition: {
            type: 'prompt',
            prompt: 'Caller has responded to the confirmation message',
          },
          destination_node_id: 'handle_final_questions',
        },
      ],
    },

    // 17. Handle Final Questions
    {
      id: 'handle_final_questions',
      type: 'conversation',
      instruction: {
        type: 'prompt',
        text:
          'Answer any remaining questions warmly using knowledge of TMW services and policies. ' +
          'Once all questions are resolved, close with: ' +
          '"We look forward to seeing you — have a wonderful day!"',
      },
      edges: [
        {
          id: 'final_questions_edge',
          transition_condition: {
            type: 'prompt',
            prompt: 'Caller has no more questions and the conversation is complete',
          },
          destination_node_id: 'end_call',
        },
      ],
    },

    // 18. End Call
    {
      id: 'end_call',
      type: 'end',
    },
  ];

  // -------------------------------------------------------------------------
  // Step 1: Create the conversation flow
  // -------------------------------------------------------------------------
  const flowPayload = {
    start_speaker: 'agent',
    start_node_id: 'welcome',
    model_choice: {
      type: 'cascading',
      model: llmModel,
    },
    global_prompt:
      `You are ${agentName}, the front desk receptionist for ${businessName} in Newtown, CT. ` +
      'You speak warmly, calmly, and professionally. ' +
      'You never use filler words like um or uh. ' +
      'You ask only one question at a time and wait for the caller\'s answer before continuing. ' +
      'You follow the conversation flow exactly as directed by each node.',
    tools: [ghlBookingTool],
    nodes,
  };

  console.log('\n--- Sova Deploy ---');
  console.log(`Client: ${businessName}`);
  console.log(`Agent:  ${agentName}`);
  console.log(`Model:  ${llmModel}`);
  console.log(`Nodes:  ${nodes.length}`);
  console.log('\nCreating conversation flow...');

  const flow = await retellPost('/create-conversation-flow', flowPayload);
  const flowId = flow.conversation_flow_id;
  console.log(`Flow created → ${flowId}`);

  // -------------------------------------------------------------------------
  // Step 2: Create the agent
  // -------------------------------------------------------------------------
  const agentPayload = {
    response_engine: {
      type: 'conversation-flow',
      conversation_flow_id: flowId,
    },
    voice_id: voiceId,
    agent_name: `${agentName} — ${businessName}`,
    language: 'en-US',
  };

  console.log('\nCreating agent...');
  const agent = await retellPost('/create-agent', agentPayload);

  console.log('\n✓ Deployment complete');
  console.log(`  Agent ID : ${agent.agent_id}`);
  console.log(`  Flow ID  : ${flowId}`);
  console.log(`  Voice    : ${voiceId}`);

  return agent;
}

deploy().catch((err) => {
  console.error('\nDeployment failed:', err.message);
  process.exit(1);
});
