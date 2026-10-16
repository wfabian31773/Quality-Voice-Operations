import type {
  IndustryReasoningPack,
  IndustryReasoningRule,
  SlotManifest,
  ReasoningContext,
} from '../types';

const SALON_URGENT_KEYWORDS = [
  'allergic reaction',
  'chemical burn',
  'severe bleeding',
  "can't breathe",
];

function classifyBookingRequest(context: ReasoningContext) {
  const utterance = context.currentUtterance.toLowerCase();
  const bookingKeywords = [
    'haircut', 'fade', 'trim', 'cut', 'color', 'highlight', 'blowout',
    'manicure', 'pedicure', 'nails', 'beard', 'shave', 'stylist',
    'barber', 'appointment', 'book', 'booking', 'schedule', 'slot',
  ];
  for (const keyword of bookingKeywords) {
    if (utterance.includes(keyword)) {
      return {
        triggered: true,
        additionalContext: 'Salon booking request. Collect service, preferred time, guest name, and phone, then use create_booking. If they asked to cancel or move an existing visit, use update_booking instead.',
      };
    }
  }
  return { triggered: false };
}

function classifyHoursOrServices(context: ReasoningContext) {
  const utterance = context.currentUtterance.toLowerCase();
  const inquiryKeywords = [
    'hours', 'open', 'close', 'closing', 'opening',
    'what do you offer', 'services', 'how much', 'price',
    'location', 'address', 'walk-in', 'walk in',
  ];
  for (const keyword of inquiryKeywords) {
    if (utterance.includes(keyword)) {
      return {
        triggered: true,
        additionalContext: 'Hours or services question. Search approved knowledge before answering. Do not invent availability or prices.',
      };
    }
  }
  return { triggered: false };
}

function classifyLeaveMessage(context: ReasoningContext) {
  const utterance = context.currentUtterance.toLowerCase();
  const messageKeywords = [
    'leave a message', 'take a message', 'leave a note',
    'tell them', 'call me back', 'callback', 'call back',
  ];
  for (const keyword of messageKeywords) {
    if (utterance.includes(keyword)) {
      return {
        triggered: true,
        additionalContext: 'Caller wants to leave a message. Collect name, phone, and the message, then use create_ticket.',
      };
    }
  }
  return { triggered: false };
}

const rules: IndustryReasoningRule[] = [
  {
    id: 'salon_booking_request',
    vertical: 'salon',
    name: 'Booking Request',
    description: 'Detect haircut, color, nails, or other salon booking requests',
    evaluate: classifyBookingRequest,
  },
  {
    id: 'salon_hours_services',
    vertical: 'salon',
    name: 'Hours and Services',
    description: 'Detect hours, price, and service-menu questions',
    evaluate: classifyHoursOrServices,
  },
  {
    id: 'salon_leave_message',
    vertical: 'salon',
    name: 'Leave a Message',
    description: 'Detect a request to leave a staff message',
    evaluate: classifyLeaveMessage,
  },
];

const bookingSlots: SlotManifest['slots'] = [
  { name: 'title', label: 'Service', required: true, prompt: 'Which service would you like to book?' },
  { name: 'startTime', label: 'Requested time', required: true, prompt: 'What day and time works for you?' },
  { name: 'contactName', label: 'Name', required: true, prompt: 'What name should I put on the appointment?' },
  { name: 'contactPhone', label: 'Phone', required: true, prompt: 'What is the best number to text or call you back?' },
  { name: 'notes', label: 'Notes', required: false, prompt: 'Any stylist preference or notes I should add?' },
];

const ticketSlots: SlotManifest['slots'] = [
  { name: 'subject', label: 'Subject', required: true, prompt: 'What should I title this message for the team?' },
  { name: 'description', label: 'Message', required: true, prompt: 'What would you like me to tell the team?' },
  { name: 'contactName', label: 'Name', required: true, prompt: 'May I have your name?' },
  { name: 'contactPhone', label: 'Phone', required: true, prompt: 'What number should they use to reach you?' },
  { name: 'category', label: 'Category', required: false, prompt: 'Is this a booking change, a question, or something else?' },
  { name: 'priority', label: 'Priority', required: false, prompt: 'How urgent is this?' },
];

const slotManifests: Record<string, SlotManifest> = {
  book_appointment: {
    vertical: 'salon',
    intent: 'book_appointment',
    slots: bookingSlots,
  },
  reschedule_cancel: {
    vertical: 'salon',
    intent: 'reschedule_cancel',
    slots: [
      { name: 'action', label: 'Change type', required: true, prompt: 'Is this a cancellation or a reschedule?' },
      { name: 'startTime', label: 'New time', required: false, prompt: 'What new day and time works if this is a reschedule?' },
      { name: 'contactName', label: 'Name', required: true, prompt: 'What name is the appointment under?' },
      { name: 'notes', label: 'Change details', required: false, prompt: 'What should change about the existing appointment?' },
    ],
  },
  hours_services: {
    vertical: 'salon',
    intent: 'hours_services',
    slots: [
      { name: 'query', label: 'Question', required: true, prompt: 'What would you like to know about our hours or services?' },
    ],
  },
  leave_message: {
    vertical: 'salon',
    intent: 'leave_message',
    slots: ticketSlots,
  },
};

export const salonPack: IndustryReasoningPack = {
  vertical: 'salon',
  displayName: 'Salon & Barbershop',
  rules,
  slotManifests,
  escalationKeywords: SALON_URGENT_KEYWORDS,
  prohibitedAdviceCategories: [],
  intentPatterns: [
    {
      intent: 'book_appointment',
      keywords: [
        'haircut', 'fade', 'trim', 'color', 'highlight', 'blowout',
        'manicure', 'pedicure', 'nails', 'beard', 'shave', 'stylist',
        'barber', 'appointment', 'book', 'booking', 'schedule', 'slot',
        'come in', 'cut my hair',
      ],
      confidence: 'high',
    },
    {
      intent: 'reschedule_cancel',
      keywords: ['reschedule', 'cancel', 'cancellation', 'move my', 'change my appointment'],
      confidence: 'high',
    },
    {
      intent: 'hours_services',
      keywords: [
        'hours', 'open', 'close', 'closing', 'opening', 'services',
        'what do you offer', 'how much', 'price', 'location', 'address',
        'walk-in', 'walk in',
      ],
      confidence: 'high',
    },
    {
      intent: 'leave_message',
      keywords: [
        'leave a message', 'take a message', 'leave a note',
        'tell them', 'call me back', 'callback', 'call back',
      ],
      confidence: 'high',
    },
  ],
  intentTools: {
    book_appointment: 'create_booking',
    reschedule_cancel: 'update_booking',
    hours_services: 'retrieve_knowledge',
    leave_message: 'create_ticket',
  },
};
