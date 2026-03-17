import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

const VERTICALS = [
  'hvac', 'plumbing', 'dental', 'medical-after-hours',
  'property-management', 'legal', 'restaurants', 'real-estate', 'insurance',
];

interface PromptEntry {
  vertical_id: string;
  category: string;
  prompt_text: string;
}

interface KnowledgeEntry {
  vertical_id: string;
  title: string;
  content: string;
  category_type: string;
  sort_order: number;
}

interface DemoFlow {
  vertical_id: string;
  scenario_name: string;
  caller_request: string;
  expected_agent_path: unknown[];
  expected_tool_calls: unknown[];
}

const promptLibrary: PromptEntry[] = [
  // ── HVAC ──
  { vertical_id: 'hvac', category: 'greeting', prompt_text: 'Thank you for calling [Business Name] heating and cooling services. My name is [Agent Name], your virtual assistant. How can I help you today with your HVAC needs?' },
  { vertical_id: 'hvac', category: 'qualification', prompt_text: 'I\'d be happy to help you with that. To get you the right service, could you tell me: 1) What type of system you have (central air, heat pump, furnace, mini-split)? 2) What issue you\'re experiencing? 3) When did the problem start? 4) Is this an emergency situation — such as no heat in winter or a gas smell?' },
  { vertical_id: 'hvac', category: 'scheduling', prompt_text: 'Based on what you\'ve described, I can schedule a service visit for you. We have availability on [dates]. Each visit includes a diagnostic assessment. Would you prefer a morning (8am-12pm) or afternoon (12pm-5pm) window? I\'ll also need your address and a contact phone number.' },
  { vertical_id: 'hvac', category: 'troubleshooting', prompt_text: 'Before we schedule a technician, let\'s try a few quick checks: 1) Is your thermostat set to the correct mode (heat/cool)? 2) Have you checked your air filter recently? A dirty filter can restrict airflow. 3) Is the outdoor unit running? 4) Are any circuit breakers tripped? If none of these resolve the issue, we\'ll get a technician out to you.' },
  { vertical_id: 'hvac', category: 'escalation', prompt_text: 'I understand this is urgent. Since you\'re reporting [gas smell / no heat in freezing temperatures / carbon monoxide alarm], I\'m going to escalate this immediately. If you smell gas, please leave the building and call 911 first. I\'m connecting you with our emergency dispatch team right now.' },

  // ── Plumbing ──
  { vertical_id: 'plumbing', category: 'greeting', prompt_text: 'Thank you for calling [Business Name] plumbing services. I\'m [Agent Name], your virtual assistant. Whether it\'s a leak, a clogged drain, or a plumbing installation, I\'m here to help. What can I assist you with today?' },
  { vertical_id: 'plumbing', category: 'qualification', prompt_text: 'Let me gather some details to connect you with the right service: 1) What type of plumbing issue are you experiencing (leak, clog, no hot water, sewer backup)? 2) Where in the property is the problem located? 3) How severe is it — is there active water damage or flooding? 4) Is this a residential or commercial property?' },
  { vertical_id: 'plumbing', category: 'scheduling', prompt_text: 'I can schedule a plumber to come out and assess the situation. We have openings on [dates]. Standard service calls include diagnosis and an estimate before any work begins. What time works best for you? I\'ll also need the service address.' },
  { vertical_id: 'plumbing', category: 'troubleshooting', prompt_text: 'Let me walk you through a few things you can check: 1) For a clogged drain, have you tried using a plunger? 2) For no hot water, check if the water heater pilot light is on. 3) For a running toilet, try jiggling the flush handle. 4) For a leak, locate the shut-off valve and turn off the water supply to prevent damage. If these don\'t help, we\'ll send someone out.' },
  { vertical_id: 'plumbing', category: 'escalation', prompt_text: 'This sounds like a plumbing emergency. [Burst pipe / sewer backup / flooding] requires immediate attention. I\'m flagging this as an emergency call. Please shut off your main water valve if possible. I\'m connecting you to our emergency plumber on call right now.' },

  // ── Dental ──
  { vertical_id: 'dental', category: 'greeting', prompt_text: 'Thank you for calling [Practice Name] dental office. I\'m [Agent Name], your virtual dental assistant. I can help you with scheduling appointments, answering questions about our services, or handling an urgent dental concern. How may I help you?' },
  { vertical_id: 'dental', category: 'qualification', prompt_text: 'I\'d like to help you get the right appointment. Could you tell me: 1) Are you a new or existing patient? 2) What type of visit are you looking for (routine cleaning, specific concern, cosmetic consultation)? 3) Are you experiencing any pain or discomfort right now? 4) Do you have dental insurance you\'d like us to verify?' },
  { vertical_id: 'dental', category: 'scheduling', prompt_text: 'Great, I can schedule that for you. We have openings for [appointment type] on [dates]. The appointment will take approximately [duration]. If you\'re a new patient, please arrive 15 minutes early to complete paperwork. Would any of these times work for you?' },
  { vertical_id: 'dental', category: 'troubleshooting', prompt_text: 'I\'m sorry to hear you\'re experiencing discomfort. While I can\'t provide medical advice, here are some general tips until you can see the dentist: 1) For tooth pain, try an over-the-counter pain reliever and rinse with warm salt water. 2) For a chipped tooth, save any pieces and rinse your mouth gently. 3) For a lost filling, you can use dental wax or sugar-free gum as a temporary cover. Shall I schedule an urgent appointment?' },
  { vertical_id: 'dental', category: 'escalation', prompt_text: 'Based on what you\'re describing — [severe pain / facial swelling / uncontrolled bleeding / knocked-out tooth] — this may require immediate attention. I\'m going to connect you directly with our on-call dentist. If you believe this is a medical emergency, please call 911 or go to your nearest emergency room.' },

  // ── Medical After Hours ──
  { vertical_id: 'medical-after-hours', category: 'greeting', prompt_text: 'Thank you for calling [Practice Name] after-hours line. I\'m [Agent Name], an AI assistant helping to triage your call. Please note that if you are experiencing a life-threatening emergency, hang up and dial 911 immediately. Otherwise, I\'m here to help assess your needs and connect you with the right care.' },
  { vertical_id: 'medical-after-hours', category: 'qualification', prompt_text: 'To help me assess your situation, please tell me: 1) Who is the patient (yourself, a child, a family member)? 2) What symptoms are you experiencing? 3) When did the symptoms start? 4) On a scale of 1-10, how would you rate any pain? 5) Have you taken any medications for this? 6) Do you have any known allergies or chronic conditions I should be aware of?' },
  { vertical_id: 'medical-after-hours', category: 'scheduling', prompt_text: 'Based on your symptoms, this sounds like something that can be addressed at your next available appointment rather than tonight. I can schedule a same-day appointment for you tomorrow morning. Our first available slot is at [time]. Would that work? If your symptoms worsen before then, please don\'t hesitate to call back or visit an urgent care facility.' },
  { vertical_id: 'medical-after-hours', category: 'troubleshooting', prompt_text: 'While I cannot provide medical advice, I can share some general comfort measures: 1) For fever, stay hydrated and consider an age-appropriate fever reducer. 2) For mild pain, rest and over-the-counter pain relief may help. 3) Keep a record of your symptoms and any changes to share with the doctor. Would you like me to page the on-call provider, or would you prefer a first-thing-in-the-morning callback?' },
  { vertical_id: 'medical-after-hours', category: 'escalation', prompt_text: 'Based on the symptoms you\'re describing — [chest pain / difficulty breathing / severe allergic reaction / signs of stroke / uncontrolled bleeding] — I strongly recommend calling 911 or going to your nearest emergency room immediately. I\'m also paging the on-call physician right now to alert them. Your safety is the priority.' },

  // ── Property Management ──
  { vertical_id: 'property-management', category: 'greeting', prompt_text: 'Thank you for calling [Company Name] property management. I\'m [Agent Name], your virtual assistant. I can help you with maintenance requests, lease questions, or general property inquiries. How can I assist you today?' },
  { vertical_id: 'property-management', category: 'qualification', prompt_text: 'Let me get the details to help you. Could you provide: 1) Your name and the property address or unit number? 2) What is the nature of your request (maintenance issue, lease question, complaint, emergency)? 3) If this is a maintenance issue, when did it start and how is it affecting your unit? 4) Is this an emergency such as flooding, fire, or security concern?' },
  { vertical_id: 'property-management', category: 'scheduling', prompt_text: 'I\'ve logged your maintenance request. Our maintenance team can visit your unit on [dates]. Standard hours are weekdays 9am-5pm. We require someone 18 or older to be present, or you can authorize entry by signing a permission form. Which time works for you? You\'ll receive a confirmation text at the number on file.' },
  { vertical_id: 'property-management', category: 'troubleshooting', prompt_text: 'Let me see if we can resolve this quickly: 1) For a clogged toilet, try using a plunger before submitting a work order. 2) For a tripped breaker, check your electrical panel and reset the tripped switch. 3) For a running toilet, try adjusting the flapper inside the tank. 4) For thermostat issues, check the battery and ensure it\'s set to the right mode. If none of these solve the problem, I\'ll submit a work order right away.' },
  { vertical_id: 'property-management', category: 'escalation', prompt_text: 'This is a property emergency. [Flooding / fire / gas leak / break-in / structural damage] requires immediate response. If you\'re in danger, please call 911 first. I\'m alerting our emergency maintenance team and the property manager right now. Stay safe and I\'ll ensure someone contacts you within 15 minutes.' },

  // ── Legal ──
  { vertical_id: 'legal', category: 'greeting', prompt_text: 'Thank you for calling [Firm Name]. I\'m [Agent Name], a virtual assistant for the firm. I can help you schedule a consultation, provide general information about our practice areas, or direct your call. Please note that I cannot provide legal advice. How can I help you today?' },
  { vertical_id: 'legal', category: 'qualification', prompt_text: 'To connect you with the right attorney, I\'ll need a few details: 1) What type of legal matter is this regarding (family law, personal injury, estate planning, business law, criminal defense)? 2) Is this a new matter or are you an existing client? 3) Are there any upcoming deadlines or court dates we should be aware of? 4) How did you hear about our firm?' },
  { vertical_id: 'legal', category: 'scheduling', prompt_text: 'I can schedule an initial consultation for you. We offer [in-person / phone / video] consultations. Our next available slot with a [practice area] attorney is on [date] at [time]. Initial consultations are [duration] and [fee structure]. Would you like me to book that for you? I\'ll send a confirmation with any documents you should prepare.' },
  { vertical_id: 'legal', category: 'troubleshooting', prompt_text: 'I understand you have questions about your case. While I can\'t provide legal advice, I can help with: 1) Checking the status of your matter — let me pull up your file. 2) Explaining our general process for [case type] matters. 3) Connecting you with your assigned attorney or paralegal. 4) Providing information about required documents. What would be most helpful?' },
  { vertical_id: 'legal', category: 'escalation', prompt_text: 'I understand this is time-sensitive. Since you\'re reporting [imminent court deadline / arrest / restraining order situation / emergency custody matter], I\'m flagging this as urgent and connecting you directly with an attorney. If this involves immediate physical danger, please contact 911. Let me get someone on the line for you right now.' },

  // ── Restaurants ──
  { vertical_id: 'restaurants', category: 'greeting', prompt_text: 'Thank you for calling [Restaurant Name]. I\'m [Agent Name], your virtual host. I can help you with reservations, takeout orders, catering inquiries, or answer questions about our menu and hours. How may I assist you today?' },
  { vertical_id: 'restaurants', category: 'qualification', prompt_text: 'I\'d be happy to help! Let me get a few details: 1) Are you looking to make a reservation, place a takeout order, or inquire about catering? 2) For reservations, how many guests and what date and time? 3) Do you have any dietary restrictions or allergies I should note? 4) Are you celebrating a special occasion?' },
  { vertical_id: 'restaurants', category: 'scheduling', prompt_text: 'I can book a table for you. We have availability for a party of [number] on [date] at [time]. Your reservation will be held for 15 minutes past the booking time. Would you like indoor or patio seating? I\'ll send a confirmation to your phone. For parties of 8 or more, we may require a pre-fixe menu or deposit.' },
  { vertical_id: 'restaurants', category: 'troubleshooting', prompt_text: 'I\'m sorry to hear about that experience. Let me help: 1) For order issues, I can check with the kitchen on your order status. 2) For a wrong or missing item, I\'ll make a note and we can arrange a replacement or credit. 3) For gift card balance questions, I can look that up for you. 4) For dietary concerns about a dish, I can check ingredients with our chef. What would you like me to do?' },
  { vertical_id: 'restaurants', category: 'escalation', prompt_text: 'I understand this is a serious concern. Since you\'re reporting [food safety issue / allergic reaction / injury on premises], your health and safety are our top priority. If anyone needs medical attention, please call 911 immediately. I\'m notifying the manager right now and they will call you back within 10 minutes. May I have your contact information?' },

  // ── Real Estate ──
  { vertical_id: 'real-estate', category: 'greeting', prompt_text: 'Thank you for calling [Agency Name] real estate. I\'m [Agent Name], your virtual assistant. Whether you\'re looking to buy, sell, or rent, I\'m here to help connect you with the right agent and information. How can I assist you today?' },
  { vertical_id: 'real-estate', category: 'qualification', prompt_text: 'To match you with the best agent and listings, could you tell me: 1) Are you interested in buying, selling, or renting? 2) What area or neighborhoods are you considering? 3) What\'s your target price range or budget? 4) How many bedrooms and bathrooms are you looking for? 5) Do you have a timeline in mind? 6) Are you pre-approved for a mortgage (for buyers)?' },
  { vertical_id: 'real-estate', category: 'scheduling', prompt_text: 'I\'d love to set up a property showing for you. The listing at [address] is available for viewing on [dates]. Showings typically last 20-30 minutes. I can also schedule a virtual tour if you prefer. Would you like me to book a time? I\'ll also connect you with [Agent Name] who specializes in that area.' },
  { vertical_id: 'real-estate', category: 'troubleshooting', prompt_text: 'I can help with that: 1) For questions about a listing, I can pull up the property details including square footage, taxes, and HOA fees. 2) For offer status updates, let me check with your agent. 3) For closing timeline questions, I can outline the typical process. 4) For document needs, I can tell you what\'s typically required at each stage. What information do you need?' },
  { vertical_id: 'real-estate', category: 'escalation', prompt_text: 'I understand the urgency. Since [the offer deadline is today / there\'s a competing offer / closing is at risk / there\'s a contract dispute], I\'m immediately notifying your agent and our broker. They will contact you within 30 minutes. Is this the best number to reach you? In the meantime, I recommend not signing anything until you\'ve spoken with your agent.' },

  // ── Insurance ──
  { vertical_id: 'insurance', category: 'greeting', prompt_text: 'Thank you for calling [Agency Name] insurance. I\'m [Agent Name], your virtual assistant. I can help you with policy questions, filing a claim, getting a quote, or updating your account information. How can I help you today?' },
  { vertical_id: 'insurance', category: 'qualification', prompt_text: 'To best assist you, I need a few details: 1) Are you an existing policyholder or looking for a new quote? 2) What type of insurance are you inquiring about (auto, home, life, business, health)? 3) If filing a claim, can you briefly describe what happened and when? 4) Do you have your policy number available?' },
  { vertical_id: 'insurance', category: 'scheduling', prompt_text: 'I can schedule a consultation with one of our licensed agents to review your coverage. We have availability on [dates] for a [phone / in-person / video] meeting. The review typically takes 30-45 minutes and we\'ll go over your current coverage, any gaps, and potential savings. Would you like to book a time?' },
  { vertical_id: 'insurance', category: 'troubleshooting', prompt_text: 'Let me help you with that: 1) For billing questions, I can look up your payment history and next due date. 2) For coverage questions, I can explain what your policy covers and your deductible amounts. 3) For ID card requests, I can send a digital copy to your email. 4) For claim status, I can check where your claim is in the process. What would you like to know?' },
  { vertical_id: 'insurance', category: 'escalation', prompt_text: 'I understand this is urgent. Since you\'re reporting [an accident that just occurred / property damage / a liability incident / a lapsed policy with immediate need], I\'m escalating this to our claims team right away. If anyone is injured, please call 911 first. Document the scene with photos if safe to do so. I\'m transferring you to a claims adjuster now.' },
];

const starterKnowledge: KnowledgeEntry[] = [
  // ── HVAC (12 articles) ──
  { vertical_id: 'hvac', title: 'Common HVAC Service Call Types', content: 'The most common HVAC service calls include: no heating or cooling, uneven temperatures between rooms, strange noises from the unit, thermostat malfunctions, poor airflow, refrigerant leaks, and high energy bills. Each type requires different diagnostic approaches and may range from simple fixes (filter replacement) to major repairs (compressor replacement).', category_type: 'Services', sort_order: 1 },
  { vertical_id: 'hvac', title: 'Emergency HVAC Situations', content: 'HVAC emergencies that require immediate dispatch include: complete heating failure during freezing temperatures (below 32°F), gas smell near the furnace (evacuate and call gas company first), carbon monoxide detector alarm, electrical burning smell from the unit, and water leaking from the HVAC system causing property damage. Always prioritize safety — advise callers to evacuate if they smell gas.', category_type: 'Procedures', sort_order: 2 },
  { vertical_id: 'hvac', title: 'Seasonal Maintenance Checklist', content: 'Spring: Schedule AC tune-up, replace air filter, clean outdoor condenser coils, check refrigerant levels. Fall: Schedule furnace inspection, replace air filter, test heating before cold weather, check carbon monoxide detectors. Year-round: Replace filters every 1-3 months, keep vents unobstructed, maintain 2 feet of clearance around outdoor units.', category_type: 'Procedures', sort_order: 3 },
  { vertical_id: 'hvac', title: 'What Does an HVAC Tune-Up Include?', content: 'A standard HVAC tune-up includes: inspecting and cleaning all components, checking electrical connections, measuring voltage and current on motors, lubricating moving parts, checking thermostat calibration, inspecting the condensate drain, checking refrigerant levels (cooling), and testing safety controls. Tune-ups typically take 1-2 hours and are recommended twice per year.', category_type: 'FAQ', sort_order: 4 },
  { vertical_id: 'hvac', title: 'Air Filter Replacement Guide', content: 'Air filters should be replaced every 1-3 months depending on usage, pets, and allergies. Standard sizes include 16x20x1, 16x25x1, 20x20x1, and 20x25x1. Higher MERV ratings (11-13) filter more particles but may restrict airflow in older systems. Customers should check their existing filter for size printed on the frame. Dirty filters cause reduced airflow, higher energy bills, and system strain.', category_type: 'Troubleshooting', sort_order: 5 },
  { vertical_id: 'hvac', title: 'Thermostat Not Working — Basic Troubleshooting', content: 'If a thermostat appears unresponsive: 1) Check batteries (many thermostats use AA or AAA). 2) Verify the circuit breaker is not tripped. 3) Ensure the system switch is in the correct position (heat/cool/auto). 4) Try raising or lowering the set temperature by 5 degrees. 5) Check for a blank display which may indicate a wiring issue. If these steps don\'t resolve it, schedule a technician visit.', category_type: 'Troubleshooting', sort_order: 6 },
  { vertical_id: 'hvac', title: 'HVAC System Lifespan and Replacement', content: 'Average HVAC system lifespans: Central AC units last 15-20 years, furnaces last 15-25 years, heat pumps last 10-15 years, and ductless mini-splits last 15-20 years. Signs it\'s time to replace: frequent repairs costing more than 50% of replacement, R-22 refrigerant systems (phased out), energy bills increasing year over year, and uneven temperatures throughout the home.', category_type: 'FAQ', sort_order: 7 },
  { vertical_id: 'hvac', title: 'Service Area and Hours', content: 'Standard service hours are Monday through Friday, 8:00 AM to 5:00 PM. Emergency service is available 24/7 with an after-hours surcharge. Service area covers a [radius] mile radius from our office. Appointments are scheduled in 4-hour windows: morning (8am-12pm) and afternoon (12pm-5pm). Same-day service is available for emergencies; routine appointments are typically 1-3 business days out.', category_type: 'FAQ', sort_order: 8 },
  { vertical_id: 'hvac', title: 'Pricing and Estimates', content: 'Service call/diagnostic fee: $79-$129 (applied toward repair cost if work is performed). Common repair ranges: thermostat replacement $150-$400, capacitor replacement $150-$300, blower motor $300-$700, refrigerant recharge $200-$500. Full system replacement: $4,000-$12,000 depending on system type and home size. Free estimates are available for system replacements. Financing options available for qualified customers.', category_type: 'FAQ', sort_order: 9 },
  { vertical_id: 'hvac', title: 'Energy Efficiency Tips for Customers', content: 'Recommendations to share with customers: Set thermostats to 68°F in winter and 78°F in summer for optimal efficiency. Use a programmable or smart thermostat. Seal air leaks around windows and doors. Ensure attic insulation meets local code requirements. Keep vents open and unblocked. Schedule regular maintenance to keep the system running efficiently. Consider upgrading to a high-efficiency system (16+ SEER rating).', category_type: 'FAQ', sort_order: 10 },
  { vertical_id: 'hvac', title: 'Warranty Information', content: 'Most HVAC manufacturers offer 5-10 year parts warranties when registered within 60 days of installation. Labor warranties vary by installer, typically 1-2 years. Extended warranty plans may be available. Warranty claims require proof of regular maintenance. Unauthorized repairs or modifications may void the warranty. Always recommend customers keep their maintenance records.', category_type: 'FAQ', sort_order: 11 },
  { vertical_id: 'hvac', title: 'Escalation Rules for HVAC Calls', content: 'Escalate immediately to on-call technician: gas smell reported, CO alarm sounding, complete heat failure below 32°F, active water leak from HVAC. Escalate to manager: customer requesting refund, complaint about technician, safety concern about installation. Escalate to sales: customer inquiring about full system replacement, commercial project inquiry. Never attempt to diagnose complex electrical or gas issues over the phone.', category_type: 'Procedures', sort_order: 12 },

  // ── Plumbing (12 articles) ──
  { vertical_id: 'plumbing', title: 'Common Plumbing Service Types', content: 'Typical plumbing service calls include: clogged drains and toilets, leaky faucets and pipes, water heater repair and installation, sewer line issues, garbage disposal problems, toilet running or not flushing, low water pressure, and pipe replacement. Drain cleaning is the most frequent service request, followed by leak repairs and water heater issues.', category_type: 'Services', sort_order: 1 },
  { vertical_id: 'plumbing', title: 'Plumbing Emergency Procedures', content: 'Plumbing emergencies requiring immediate dispatch: burst pipes (instruct caller to shut off main water valve), sewer backup into living space, gas line leak (evacuate first, call gas company), no water to entire property, flooding from any source. For burst pipes, the main shut-off valve is typically near the water meter or where the main line enters the home. Time is critical — every minute of delay can cause significant water damage.', category_type: 'Procedures', sort_order: 2 },
  { vertical_id: 'plumbing', title: 'Water Heater Troubleshooting', content: 'Common water heater issues: No hot water — check pilot light (gas) or breaker (electric), check thermostat setting (recommended 120°F). Not enough hot water — may indicate sediment buildup, undersized tank, or failing heating element. Strange noises — usually sediment buildup, recommend flushing. Leaking — check T&P relief valve and connections; tank leaks mean replacement needed. Water heaters last 8-12 years on average.', category_type: 'Troubleshooting', sort_order: 3 },
  { vertical_id: 'plumbing', title: 'Drain Cleaning Methods', content: 'Professional drain cleaning methods include: snaking/augering (most common, for simple clogs), hydro-jetting (high-pressure water for grease and buildup), camera inspection (to diagnose hidden issues), and chemical treatments (enzyme-based only — never recommend chemical drain cleaners to customers). Advise customers not to use store-bought chemical drain cleaners as they can damage pipes and create hazardous conditions for technicians.', category_type: 'Services', sort_order: 4 },
  { vertical_id: 'plumbing', title: 'How to Shut Off Your Water', content: 'Instruct callers on water shut-off: Individual fixtures have shut-off valves underneath or behind them — turn clockwise to close. The main water shut-off is typically near the water meter, in the basement, or near where the main line enters the home. Outdoor shut-off may require a meter key. In apartments, the shut-off may be in a utility closet or require building maintenance. If unsure, turn off water at the meter.', category_type: 'Troubleshooting', sort_order: 5 },
  { vertical_id: 'plumbing', title: 'Plumbing Service Pricing Guide', content: 'Standard rates: Service/diagnostic fee $75-$125. Drain cleaning $150-$350. Faucet repair $100-$250. Toilet repair $100-$300. Water heater replacement $800-$2,500+ (tank), $2,500-$5,000+ (tankless). Sewer line repair $1,000-$5,000+. Emergency/after-hours calls include additional surcharge. Free estimates for large projects. Financing available.', category_type: 'FAQ', sort_order: 6 },
  { vertical_id: 'plumbing', title: 'Sewer Line Issues and Signs', content: 'Signs of sewer line problems: multiple slow drains throughout the home, gurgling sounds from drains, sewage odor inside or outside, wet spots in the yard, and sewage backup. Common causes: tree root intrusion, pipe corrosion or collapse, grease buildup, and foreign objects. Diagnosis typically requires a camera inspection ($150-$400). Repair methods range from trenchless relining to traditional excavation.', category_type: 'Troubleshooting', sort_order: 7 },
  { vertical_id: 'plumbing', title: 'Preventive Plumbing Maintenance', content: 'Annual maintenance recommendations: inspect all visible pipes for leaks or corrosion, flush water heater to remove sediment, test sump pump operation, check washing machine hoses (replace every 5 years), clean aerators on faucets, test water pressure (40-60 PSI is normal), and inspect toilet components. Preventive maintenance can avoid costly emergency repairs.', category_type: 'Procedures', sort_order: 8 },
  { vertical_id: 'plumbing', title: 'Running Toilet Fix Guide', content: 'A running toilet wastes up to 200 gallons per day. Common causes and fixes: 1) Flapper valve worn — replacement costs $5-$15 at hardware store. 2) Float set too high — adjust float ball or cup down. 3) Fill valve failing — replacement $10-$25. 4) Flush valve seat corroded — may need toilet replacement. Walk customers through jiggling the handle first, then checking if the flapper seals properly.', category_type: 'Troubleshooting', sort_order: 9 },
  { vertical_id: 'plumbing', title: 'Service Area and Scheduling', content: 'Service available Monday through Saturday, 7:00 AM to 6:00 PM. 24/7 emergency service available. Service area covers [radius] miles. Appointments are scheduled in 2-hour windows. Same-day service available for emergencies. Standard appointments are typically 1-2 business days out. Technicians call 30 minutes before arrival.', category_type: 'FAQ', sort_order: 10 },
  { vertical_id: 'plumbing', title: 'Garbage Disposal Care and Issues', content: 'Common garbage disposal problems: jammed (use Allen wrench on bottom to manually rotate), not turning on (check reset button on bottom of unit, then check breaker), leaking (connections may need tightening or gaskets replaced). Items that should NOT go in disposal: grease/oil, fibrous foods (celery, corn husks), bones, pasta/rice (expands), coffee grounds in large amounts, and non-food items.', category_type: 'Troubleshooting', sort_order: 11 },
  { vertical_id: 'plumbing', title: 'Plumbing Escalation Rules', content: 'Immediate escalation: active flooding, sewer backup, gas line concerns, no water to property. Manager escalation: pricing disputes, warranty claims, complaints about service. Sales escalation: bathroom/kitchen remodel inquiries, whole-house repiping, commercial projects, new construction. Never advise customers to attempt gas line repairs themselves.', category_type: 'Procedures', sort_order: 12 },

  // ── Dental (12 articles) ──
  { vertical_id: 'dental', title: 'Appointment Types and Duration', content: 'Standard appointment types: New patient exam and cleaning (90 minutes), routine cleaning and exam (60 minutes), emergency/pain visit (30 minutes), crown preparation (90 minutes), filling (45-60 minutes), root canal (60-90 minutes), extraction (30-60 minutes), cosmetic consultation (45 minutes), teeth whitening (60-90 minutes). New patients should arrive 15 minutes early for paperwork.', category_type: 'Services', sort_order: 1 },
  { vertical_id: 'dental', title: 'Dental Emergency Guidelines', content: 'Dental emergencies that warrant same-day scheduling: severe toothache unresponsive to OTC pain relief, knocked-out permanent tooth (re-implant within 30 minutes if possible — store in milk), broken tooth with sharp edges cutting tissue, abscess or facial swelling, uncontrolled bleeding after procedure, broken or lost temporary crown. Refer to ER: facial trauma with suspected jaw fracture, difficulty breathing from swelling, heavy uncontrolled bleeding.', category_type: 'Procedures', sort_order: 2 },
  { vertical_id: 'dental', title: 'Insurance and Payment Information', content: 'We accept most major dental insurance plans including Delta Dental, Cigna, MetLife, Aetna, and Guardian. Insurance verification is done at scheduling. Patients are responsible for co-pays and deductibles at the time of service. For uninsured patients, we offer an in-house membership plan: $299/year includes 2 cleanings, exams, and x-rays with 15% off additional treatment. Payment plans available for treatment over $500.', category_type: 'FAQ', sort_order: 3 },
  { vertical_id: 'dental', title: 'New Patient Information', content: 'What new patients need to bring: photo ID, dental insurance card, list of current medications, medical history including allergies, and any recent dental X-rays (can be sent digitally from previous dentist). New patient forms are available online at our website and can be completed before the visit. First visits include comprehensive exam, full-mouth X-rays, and cleaning (if time allows).', category_type: 'FAQ', sort_order: 4 },
  { vertical_id: 'dental', title: 'Teeth Whitening Options', content: 'We offer two professional whitening options: In-office whitening (Zoom or equivalent) — single visit, approximately 90 minutes, results up to 8 shades whiter, $400-$600. Take-home custom tray whitening — custom-fitted trays with professional-grade gel, worn 30-60 minutes daily for 2 weeks, $250-$350. Both options deliver significantly better results than over-the-counter products. Not recommended for patients with sensitive teeth without consultation.', category_type: 'Services', sort_order: 5 },
  { vertical_id: 'dental', title: 'Toothache Self-Care Before Appointment', content: 'Recommendations for patients with toothache before their appointment: Take ibuprofen (Advil) or acetaminophen (Tylenol) as directed — do not exceed recommended dose. Rinse gently with warm salt water (1/2 teaspoon salt in 8 oz warm water). Apply a cold compress to the outside of the cheek for 15-20 minutes. Avoid very hot, cold, or sweet foods and drinks. Do NOT place aspirin directly on the gum — this can burn tissue.', category_type: 'Troubleshooting', sort_order: 6 },
  { vertical_id: 'dental', title: 'Cancellation and No-Show Policy', content: 'Please provide at least 24 hours notice for cancellations or rescheduling. Late cancellations (under 24 hours) may incur a $50 fee. No-shows may be charged $75. Two consecutive no-shows may result in requiring a deposit for future appointments. Emergency cancellations due to illness are handled on a case-by-case basis. We maintain a cancellation waitlist and may be able to fill the slot.', category_type: 'FAQ', sort_order: 7 },
  { vertical_id: 'dental', title: 'Pediatric Dentistry Services', content: 'We welcome children starting at age 1 or when their first tooth appears. Pediatric services include: well-child dental exams, cleanings, fluoride treatments, dental sealants, space maintainers, and gentle behavior management. We recommend scheduling children\'s appointments in the morning when they\'re most cooperative. Parents are welcome in the treatment room for children under 12.', category_type: 'Services', sort_order: 8 },
  { vertical_id: 'dental', title: 'Post-Procedure Care Instructions', content: 'After fillings: avoid chewing on the treated side for 2 hours; sensitivity is normal for a few days. After extraction: bite on gauze for 30 minutes, avoid straws and spitting for 24 hours, soft foods only, no smoking. After root canal: avoid chewing until the permanent crown is placed, take prescribed antibiotics fully. After cleaning: minor bleeding and sensitivity are normal. Call if pain worsens or doesn\'t improve within 3-5 days.', category_type: 'Procedures', sort_order: 9 },
  { vertical_id: 'dental', title: 'Office Hours and Location', content: 'Office hours: Monday-Thursday 8:00 AM - 5:00 PM, Friday 8:00 AM - 2:00 PM. Closed weekends. Emergency line available after hours. Located at [address]. Free parking available. Wheelchair accessible. Nearest public transit: [details]. For after-hours dental emergencies, call our main number and follow the prompts to reach the on-call dentist.', category_type: 'FAQ', sort_order: 10 },
  { vertical_id: 'dental', title: 'Dental Implants Overview', content: 'Dental implants are a permanent solution for missing teeth. The process involves: consultation and CT scan, implant placement surgery (1-2 hours), healing period (3-6 months for osseointegration), abutment placement, and final crown. Cost: $3,000-$5,000 per implant. Many insurance plans cover a portion. Ideal candidates have adequate bone density and good overall health. Not recommended for heavy smokers without cessation.', category_type: 'Services', sort_order: 11 },
  { vertical_id: 'dental', title: 'Dental Call Escalation Rules', content: 'Escalate to on-call dentist: severe pain not managed by OTC medication, facial swelling, knocked-out tooth (time-critical), uncontrolled post-procedure bleeding. Escalate to office manager: billing disputes, insurance complaints, patient complaints about care. Refer to ER: facial trauma, suspected jaw fracture, difficulty breathing or swallowing, allergic reaction to medication. Never diagnose or recommend specific treatment over the phone.', category_type: 'Procedures', sort_order: 12 },

  // ── Medical After Hours (12 articles) ──
  { vertical_id: 'medical-after-hours', title: 'Symptom Triage Categories', content: 'Emergency (call 911): chest pain, difficulty breathing, severe allergic reaction, signs of stroke (FAST: Face drooping, Arm weakness, Speech difficulty, Time to call), uncontrolled bleeding, loss of consciousness. Urgent (page on-call provider): high fever >103°F in adults, moderate allergic reaction, severe abdominal pain, head injury with confusion, dehydration signs. Routine (next-day callback): mild cold/flu symptoms, medication refill requests, non-urgent test result questions, minor rashes.', category_type: 'Procedures', sort_order: 1 },
  { vertical_id: 'medical-after-hours', title: 'After-Hours Call Protocol', content: 'Step 1: Greet and identify. Step 2: Screen for emergencies (chest pain, difficulty breathing, stroke symptoms). Step 3: Collect patient info (name, DOB, phone, reason). Step 4: Assess urgency using triage guidelines. Step 5: For emergencies, direct to 911 and page provider. For urgent, page on-call provider with callback number. For routine, create a message for next-day follow-up. Step 6: Confirm callback expectations. Always document the call.', category_type: 'Procedures', sort_order: 2 },
  { vertical_id: 'medical-after-hours', title: 'Fever Guidelines by Age', content: 'Infants 0-3 months: Any fever 100.4°F or higher is an emergency — refer to ER immediately. Infants 3-6 months: Fever 102°F+ page on-call provider. Children 6 months - 17 years: Fever 104°F+ or fever lasting more than 3 days, page provider. Adults: Fever 103°F+ or with severe symptoms, page provider. Advise hydration and age-appropriate fever reducers. Never recommend aspirin for children under 18.', category_type: 'Troubleshooting', sort_order: 3 },
  { vertical_id: 'medical-after-hours', title: 'Medication Refill Requests', content: 'After-hours medication refill protocol: Controlled substances (narcotics, benzodiazepines, stimulants) cannot be refilled after hours — patient must call during office hours. Maintenance medications (blood pressure, diabetes, thyroid): if patient will run out before next business day, page on-call provider for emergency refill. Antibiotics in progress: page provider if needed to continue course. Always verify patient identity and medication name, dose, and pharmacy.', category_type: 'Procedures', sort_order: 4 },
  { vertical_id: 'medical-after-hours', title: 'Pediatric After-Hours Guidelines', content: 'Always page the on-call provider for: infants under 3 months with any symptoms, difficulty breathing in any child, child not drinking fluids for 8+ hours, rash with fever, persistent vomiting preventing medication, severe ear pain, potential broken bone. Comfort measures to suggest: cool compress for fever, pedialyte for dehydration, saline drops for congestion, elevated head for croup. Never recommend dosages — the provider will advise.', category_type: 'Troubleshooting', sort_order: 5 },
  { vertical_id: 'medical-after-hours', title: 'Mental Health Crisis Protocol', content: 'If a caller expresses suicidal thoughts or self-harm: Stay calm and stay on the line. Ask directly: "Are you thinking about hurting yourself?" If yes, ask if they have a plan or means. Provide the 988 Suicide & Crisis Lifeline (call or text 988). Do not hang up until the caller is connected with help. Page the on-call provider immediately. If the caller is in immediate danger, call 911 with their location. Document the call thoroughly.', category_type: 'Procedures', sort_order: 6 },
  { vertical_id: 'medical-after-hours', title: 'Common After-Hours Scenarios', content: 'Most frequent after-hours calls: 1) Child with fever (35%). 2) Adult pain management (15%). 3) Medication questions (12%). 4) Post-procedure concerns (10%). 5) GI symptoms — nausea/vomiting/diarrhea (10%). 6) Respiratory symptoms (8%). 7) Test result anxiety (5%). 8) Rash or allergic reaction (5%). Having clear protocols for these common scenarios enables efficient triage.', category_type: 'FAQ', sort_order: 7 },
  { vertical_id: 'medical-after-hours', title: 'Urgent Care vs. ER Guidance', content: 'Suggest Urgent Care for: minor cuts needing stitches, sprains and strains, UTI symptoms, ear/sinus infections, mild allergic reactions, minor burns, flu with manageable symptoms. Direct to ER for: chest pain, stroke symptoms, severe allergic reaction/anaphylaxis, heavy uncontrolled bleeding, compound fractures, severe burns, head trauma with loss of consciousness, high fever in infants under 3 months.', category_type: 'FAQ', sort_order: 8 },
  { vertical_id: 'medical-after-hours', title: 'Patient Callback Expectations', content: 'Emergency pages: provider will call back within 15 minutes. If no callback in 15 minutes, the patient should call back and we will re-page. Urgent pages: provider will call back within 30 minutes. Routine messages: the office will follow up on the next business day by end of day. Always confirm the best callback number and inform patients to keep their phone accessible. If condition worsens while waiting, call 911.', category_type: 'FAQ', sort_order: 9 },
  { vertical_id: 'medical-after-hours', title: 'HIPAA Compliance Reminders', content: 'After-hours call handlers must: verify patient identity (name, DOB, and one additional identifier). Only share information with the patient or authorized contacts listed in their record. Do not leave detailed medical information on voicemail — only request a callback. Document calls in the secure system, never on personal notes. All call recordings are confidential. Report any suspected breach immediately.', category_type: 'Procedures', sort_order: 10 },
  { vertical_id: 'medical-after-hours', title: 'On-Call Provider Paging Guide', content: 'Paging process: 1) Identify the on-call provider from the schedule. 2) Send page with: patient name, DOB, callback number, brief reason, and urgency level. 3) Inform patient of expected callback time. 4) If no response in 15 minutes (emergency) or 30 minutes (urgent), re-page and try backup provider. 5) If backup is unreachable, contact the practice administrator. Always document page time and response time.', category_type: 'Procedures', sort_order: 11 },
  { vertical_id: 'medical-after-hours', title: 'Medical After-Hours Escalation Rules', content: 'Immediate 911 referral: chest pain, stroke symptoms, difficulty breathing, severe bleeding, loss of consciousness, suicidal with plan/means. Page on-call immediately: infant under 3 months with any symptoms, high fever with additional concerning symptoms, severe allergic reaction, post-surgical complications. Page can wait 15 minutes: moderate symptoms in otherwise healthy patients, non-urgent medication needs. Next business day: routine refills, appointment requests, mild chronic condition questions.', category_type: 'Procedures', sort_order: 12 },

  // ── Property Management (12 articles) ──
  { vertical_id: 'property-management', title: 'Maintenance Request Categories', content: 'Priority 1 (Emergency — respond within 1 hour): fire, flooding, gas leak, no heat in winter, no AC when above 95°F, security breach, sewage backup. Priority 2 (Urgent — respond within 24 hours): no hot water, broken door lock, refrigerator not working, toilet not flushing (if only toilet). Priority 3 (Routine — respond within 3-5 business days): dripping faucet, running toilet (second toilet available), minor appliance issues, cosmetic damage.', category_type: 'Procedures', sort_order: 1 },
  { vertical_id: 'property-management', title: 'Emergency Maintenance Protocol', content: 'For property emergencies: 1) Assess safety — is anyone in danger? If yes, call 911 first. 2) Instruct tenant on immediate steps (shut off water, evacuate for gas). 3) Dispatch emergency maintenance or approved vendor. 4) Notify property manager via phone and email. 5) Document with photos if possible. 6) Follow up within 2 hours to confirm issue is being addressed. 7) File incident report within 24 hours.', category_type: 'Procedures', sort_order: 2 },
  { vertical_id: 'property-management', title: 'Lease FAQ — Common Tenant Questions', content: 'Rent due date: 1st of each month, grace period until the 5th. Late fee: $50 or 5% of rent after grace period. Lease renewal: we contact you 60 days before expiration. Early termination: requires 60-day notice and early termination fee (typically 2 months rent). Subletting: not allowed without written approval. Guest policy: guests staying more than 14 consecutive days must be reported. Parking: assigned spaces per lease agreement.', category_type: 'FAQ', sort_order: 3 },
  { vertical_id: 'property-management', title: 'Move-In/Move-Out Procedures', content: 'Move-in: Schedule key pickup, complete move-in inspection checklist (document existing conditions with photos), set up utilities in tenant\'s name, review building rules. Move-out: Provide 30-day written notice, schedule move-out inspection, return keys and access devices, clean unit to move-in condition, forward mailing address. Security deposit returned within 30 days minus documented damages beyond normal wear and tear.', category_type: 'Procedures', sort_order: 4 },
  { vertical_id: 'property-management', title: 'Rent Payment Methods', content: 'Accepted payment methods: Online portal (preferred — available 24/7), ACH bank transfer (set up through resident portal), certified check or money order (delivered to office), credit/debit card (convenience fee applies). Personal checks accepted from established tenants only. Cash is not accepted. Payment receipts are automatically generated through the online portal. Set up autopay to avoid late fees.', category_type: 'FAQ', sort_order: 5 },
  { vertical_id: 'property-management', title: 'Noise Complaint Procedures', content: 'Quiet hours are 10:00 PM to 8:00 AM on weekdays and 11:00 PM to 9:00 AM on weekends. For noise complaints during quiet hours: 1) First, try speaking politely with the neighbor. 2) If unresolved, call the after-hours line and we\'ll attempt to contact the tenant. 3) If it\'s a repeated issue, submit a written complaint through the portal. 4) After 3 documented complaints, formal warnings are issued. 5) Ongoing violations may result in lease action.', category_type: 'Procedures', sort_order: 6 },
  { vertical_id: 'property-management', title: 'Pet Policy', content: 'Pet policy varies by property. Generally: Maximum 2 pets per unit. Approved breeds only (see restricted breed list). Pet deposit: $250-$500. Monthly pet rent: $25-$50 per pet. Required: up-to-date vaccinations and licensing. All pets must be leashed in common areas. Tenants are responsible for cleaning up after pets. Violations may result in additional charges or removal of pet privilege. Service animals are exempt from pet fees.', category_type: 'FAQ', sort_order: 7 },
  { vertical_id: 'property-management', title: 'Common Appliance Troubleshooting', content: 'Before submitting a work order: Dishwasher not draining — check and clean the filter, ensure drain hose isn\'t kinked. Garbage disposal jammed — use reset button on bottom, use Allen wrench to manually turn. HVAC not working — check thermostat batteries and settings, check breaker. Washer not draining — check for items in the pump filter. Dryer not heating — clean lint trap, check breaker. If these don\'t help, submit a maintenance request.', category_type: 'Troubleshooting', sort_order: 8 },
  { vertical_id: 'property-management', title: 'Lockout Procedures', content: 'During office hours: Bring photo ID to the leasing office for a spare key. After hours: Call the emergency line for lockout assistance. Locksmith fees ($75-$150) are the tenant\'s responsibility unless the lock is malfunctioning. For lost keys, a lock change will be performed at tenant\'s expense ($100-$200). We recommend keeping a spare key with a trusted person. Smart lock codes can be reset by the management team during business hours.', category_type: 'FAQ', sort_order: 9 },
  { vertical_id: 'property-management', title: 'Property Rules and Common Areas', content: 'Smoking: Not permitted inside any unit or within 25 feet of buildings. Common areas: Must be kept clean after use. Pool/gym hours: 6:00 AM - 10:00 PM. Grilling: Only in designated areas with approved grills. Storage units: Available for rent, contact office. Package delivery: Packages are delivered to individual units; the office does not accept packages on behalf of residents. Trash and recycling: follow posted schedule for collection days.', category_type: 'FAQ', sort_order: 10 },
  { vertical_id: 'property-management', title: 'Renewal and Rent Increase Process', content: 'Lease renewal notices are sent 60-90 days before expiration. Renewal offers include the new monthly rate. Tenants have 30 days to accept or decline. If no response, the lease converts to month-to-month at a higher rate. Rent increases are based on market conditions, typically 3-5% annually. Tenants in good standing may receive preferential renewal rates. Early renewal commitments may receive rate lock benefits.', category_type: 'FAQ', sort_order: 11 },
  { vertical_id: 'property-management', title: 'Property Management Escalation Rules', content: 'Emergency dispatch (immediate): flooding, fire, gas leak, break-in, structural failure. Urgent maintenance (24hr): no hot water, broken lock, HVAC failure, appliance leak. Manager notification: tenant complaints, lease violations, repeated maintenance issues, eviction-related calls. Regional manager: safety concerns, threatened legal action, media inquiries, large-scale damage. Never authorize repairs over $500 without manager approval.', category_type: 'Procedures', sort_order: 12 },

  // ── Legal (12 articles) ──
  { vertical_id: 'legal', title: 'Practice Areas Overview', content: 'Our firm handles cases in the following areas: Family Law (divorce, custody, support, adoption), Personal Injury (auto accidents, slip and fall, medical malpractice), Estate Planning (wills, trusts, probate, power of attorney), Business Law (formation, contracts, disputes, employment), Criminal Defense (DUI, misdemeanors, felonies), and Immigration (visas, green cards, citizenship, deportation defense). Each area has dedicated attorneys.', category_type: 'Services', sort_order: 1 },
  { vertical_id: 'legal', title: 'Initial Consultation Process', content: 'Free 30-minute consultations are available for personal injury and criminal defense cases. Other practice areas: $150-$250 for initial consultation (applied toward retainer if retained). Consultations can be in-person, by phone, or video. What to bring: relevant documents (police reports, contracts, correspondence), timeline of events, list of questions, photo ID. Consultations are confidential even if the caller doesn\'t retain the firm.', category_type: 'Services', sort_order: 2 },
  { vertical_id: 'legal', title: 'Statute of Limitations Quick Reference', content: 'Common deadlines (vary by state — confirm with attorney): Personal injury: 2-3 years from injury date. Medical malpractice: 2-3 years from discovery. Property damage: 3-6 years. Contract disputes: 4-6 years (written), 2-4 years (oral). Employment discrimination: 180-300 days (EEOC charge). Criminal charges: varies by offense. Missing a deadline can permanently bar a claim. Always recommend callers consult an attorney promptly.', category_type: 'FAQ', sort_order: 3 },
  { vertical_id: 'legal', title: 'Fee Structures Explained', content: 'Fee arrangements: Contingency (personal injury) — no upfront fee, firm takes 33-40% of recovery. Hourly — attorney rates $200-$500/hour, billed in 6-minute increments. Flat fee — common for simple matters (will preparation $500-$1,500, uncontested divorce $1,500-$3,000). Retainer — upfront deposit drawn against as work is performed. Payment plans available for select case types. Fee agreements are provided in writing before engagement.', category_type: 'FAQ', sort_order: 4 },
  { vertical_id: 'legal', title: 'What Happens After I Hire an Attorney?', content: 'After retaining the firm: 1) You sign a fee agreement and engagement letter. 2) Your case is assigned to an attorney and paralegal team. 3) We gather relevant documents and evidence. 4) We communicate with opposing parties or their attorneys. 5) We keep you informed of all developments. 6) Key decisions (settlement offers, plea deals) are always your decision. Typical response time: 1-2 business days for non-urgent communications.', category_type: 'FAQ', sort_order: 5 },
  { vertical_id: 'legal', title: 'Divorce and Custody Basics', content: 'Divorce process overview: filing petition, temporary orders (custody, support), discovery phase, negotiation/mediation, trial if unresolved. Uncontested divorces (both parties agree) are faster and less expensive. Custody factors courts consider: child\'s best interests, parent-child relationships, stability, each parent\'s ability to co-parent. We strongly encourage mediation before litigation. Initial family law consultation helps assess options.', category_type: 'FAQ', sort_order: 6 },
  { vertical_id: 'legal', title: 'Criminal Defense — What to Do After Arrest', content: 'Advice for callers after an arrest: Exercise your right to remain silent — do not make statements to police. Request an attorney immediately. Do not consent to searches. Note the officers\' names and badge numbers. Do not discuss the case on the phone from jail (calls are recorded). Contact us immediately — we can attend arraignment. Bail hearing is typically within 24-48 hours. Time is critical in criminal matters.', category_type: 'Procedures', sort_order: 7 },
  { vertical_id: 'legal', title: 'Estate Planning Essentials', content: 'Essential estate planning documents: Last Will and Testament (directs asset distribution), Revocable Living Trust (avoids probate, provides management if incapacitated), Financial Power of Attorney (designates financial decision-maker), Healthcare Power of Attorney / Healthcare Proxy (designates medical decision-maker), Living Will / Advance Directive (end-of-life preferences). Everyone over 18 should have at minimum a will and healthcare directive.', category_type: 'Services', sort_order: 8 },
  { vertical_id: 'legal', title: 'Important Legal Disclaimers', content: 'The virtual assistant cannot provide legal advice. All information shared is general in nature and should not be relied upon as legal counsel. Every case is unique and requires individual attorney review. No attorney-client relationship is formed by speaking with the virtual assistant. Confidentiality protections apply only after formal engagement with the firm. For urgent legal matters, we will connect you directly with an attorney.', category_type: 'Procedures', sort_order: 9 },
  { vertical_id: 'legal', title: 'Document Preparation Checklist', content: 'For your consultation, please prepare: Personal injury — accident report, medical records, insurance info, photos, witness contacts. Family law — financial documents, tax returns, parenting plan proposals. Estate planning — asset list, beneficiary information, existing documents. Business — formation documents, contracts in question, financial statements. Criminal — arrest/booking information, court notices, any evidence.', category_type: 'Procedures', sort_order: 10 },
  { vertical_id: 'legal', title: 'Conflict Check Process', content: 'Before scheduling a consultation, we perform a conflict check to ensure no conflicts of interest exist. We need: your full legal name, names of all parties involved in the matter, and the general nature of the case. This process typically takes 1 business day. If a conflict exists, we will refer you to another qualified firm. The conflict check information is kept confidential.', category_type: 'Procedures', sort_order: 11 },
  { vertical_id: 'legal', title: 'Legal Call Escalation Rules', content: 'Direct attorney connect: active arrest/detention, court hearing within 24 hours, protective order needed immediately, child in danger. Office manager: fee disputes, complaint about representation, request to change attorney. Intake coordinator: new case inquiries, consultation scheduling. Refer to other resources: matters outside our practice areas, pro bono needs (provide legal aid numbers), opposing party calling about a case we handle.', category_type: 'Procedures', sort_order: 12 },

  // ── Restaurants (12 articles) ──
  { vertical_id: 'restaurants', title: 'Reservation Policy', content: 'Reservations accepted for parties of 1-8 guests. Parties of 8+ require pre-arrangement and may need a pre-fixe menu or minimum spend. Reservations held for 15 minutes past booking time. Cancellation: 2+ hours notice for small parties, 24 hours for large parties. No-show policy: after 2 no-shows, future reservations require credit card hold. Walk-ins welcome based on availability. Private dining available for events of 15-50 guests.', category_type: 'FAQ', sort_order: 1 },
  { vertical_id: 'restaurants', title: 'Menu and Dietary Information', content: 'Our menu features [cuisine type] with options for various dietary needs. Vegetarian and vegan options are marked on the menu. Gluten-free preparations available for most dishes — please inform your server. Common allergens in our kitchen: nuts, shellfish, dairy, soy, wheat, eggs. We cannot guarantee a 100% allergen-free environment. Full menu and allergen information available on our website. Seasonal menu changes occur quarterly.', category_type: 'FAQ', sort_order: 2 },
  { vertical_id: 'restaurants', title: 'Catering Services', content: 'We offer full-service catering for events of 20-200 guests. Catering packages include: appetizer-only packages starting at $25/person, dinner packages starting at $45/person, and full-service with bar starting at $75/person. Requires 2 weeks advance booking. Tastings available for events over 50 guests. Staffing, rentals, and setup/breakdown included in full-service packages. Custom menus available. Delivery-only options also available at reduced rates.', category_type: 'Services', sort_order: 3 },
  { vertical_id: 'restaurants', title: 'Hours and Location', content: 'Restaurant hours: Lunch Tuesday-Friday 11:30 AM - 2:30 PM. Dinner Tuesday-Thursday 5:00 PM - 9:30 PM. Dinner Friday-Saturday 5:00 PM - 10:30 PM. Sunday Brunch 10:00 AM - 2:30 PM. Closed Mondays. Bar open until 11:00 PM Thursday-Saturday. Happy Hour Tuesday-Friday 4:00 PM - 6:00 PM. Kitchen closes 30 minutes before restaurant closing. Holiday hours may vary — check website.', category_type: 'FAQ', sort_order: 4 },
  { vertical_id: 'restaurants', title: 'Takeout and Delivery', content: 'Takeout available during all service hours. Order by phone or through our website/app. Average preparation time: 20-30 minutes. Delivery available within a 5-mile radius through our own drivers and [third-party platforms]. Delivery minimum order: $25. Delivery fee: $5 (waived on orders over $75). Curbside pickup available — call when you arrive. Large takeout orders (10+ entrees) require 2 hours notice.', category_type: 'Services', sort_order: 5 },
  { vertical_id: 'restaurants', title: 'Gift Cards and Loyalty Program', content: 'Gift cards available in any denomination from $25 to $500. Purchase in-restaurant or online. E-gift cards available for instant delivery. Gift cards never expire and have no fees. Loyalty program: earn 1 point per dollar spent. 100 points = $10 reward. Members receive a birthday reward and exclusive event invitations. Sign up through our app or at the host stand.', category_type: 'Services', sort_order: 6 },
  { vertical_id: 'restaurants', title: 'Allergy and Special Dietary Handling', content: 'When a caller mentions allergies: document the specific allergy on the reservation notes. Inform the caller that we take allergies seriously and the chef will be notified. For severe allergies (anaphylaxis risk), recommend speaking directly with the chef or manager before ordering. We can accommodate: gluten-free, dairy-free, nut-free, vegan, vegetarian, and low-sodium diets. Cross-contamination risk exists in our shared kitchen.', category_type: 'Procedures', sort_order: 7 },
  { vertical_id: 'restaurants', title: 'Private Events and Parties', content: 'Private dining room seats 15-50 guests. Semi-private area for 10-25 guests. Buyout of full restaurant available for 80-120 guests. Event packages include: set menu selection (3-4 courses), beverage packages (2-4 hour options), dedicated event coordinator, AV equipment, and custom table arrangements. Deposits required: 25% at booking, balance due 7 days before event. Holiday season and weekends book 2-3 months in advance.', category_type: 'Services', sort_order: 8 },
  { vertical_id: 'restaurants', title: 'Handling Customer Complaints', content: 'When a customer calls with a complaint: 1) Listen fully without interrupting. 2) Apologize sincerely. 3) Document the issue (date, time, server, specific problem). 4) For food quality issues: offer to replace the dish or provide a credit. 5) For service issues: offer a discount on next visit. 6) For food safety concerns: escalate to manager immediately. 7) Never argue or dismiss the concern. Manager callback within 24 hours for all escalated issues.', category_type: 'Procedures', sort_order: 9 },
  { vertical_id: 'restaurants', title: 'Food Safety and Allergic Reaction Protocol', content: 'If a customer reports an allergic reaction: Take it seriously immediately. Call 911 if symptoms are severe (difficulty breathing, swelling, anaphylaxis). Note: time of reaction, what was consumed, symptoms. Manager must be contacted immediately. Preserve a sample of the dish if possible. File an incident report. Follow up with the customer within 24 hours. Review kitchen procedures for the dish in question.', category_type: 'Procedures', sort_order: 10 },
  { vertical_id: 'restaurants', title: 'Wait Time and Table Management', content: 'Typical wait times: Lunch 10-15 minutes, Dinner weekdays 15-20 minutes, Dinner weekends 30-60 minutes. Guests can join the waitlist by calling or using our app. Text notifications sent when table is ready. Bar seating available on a first-come basis during waits. For long waits, we offer complimentary bar snacks to waiting guests. Reservations always receive priority.', category_type: 'FAQ', sort_order: 11 },
  { vertical_id: 'restaurants', title: 'Restaurant Escalation Rules', content: 'Manager immediate: food safety complaint, allergic reaction, intoxicated guest, injury on premises, large party complaint. Manager within 1 hour: food quality issue, service complaint, billing dispute. Chef notification: allergy inquiries for severe allergies, custom dietary requests for large parties. Owner notification: media inquiries, legal threats, health department visit. Never disclose specific employee information to callers.', category_type: 'Procedures', sort_order: 12 },

  // ── Real Estate (12 articles) ──
  { vertical_id: 'real-estate', title: 'Buying Process Overview', content: 'Steps in the home buying process: 1) Get pre-approved for a mortgage. 2) Define your criteria (location, size, features, budget). 3) Work with an agent to view properties. 4) Make an offer. 5) Negotiate terms. 6) Home inspection and appraisal. 7) Review title and disclosures. 8) Final walkthrough. 9) Closing day — sign documents and receive keys. Typical timeline: 30-60 days from accepted offer to closing. Buyer\'s agent services are typically free to the buyer.', category_type: 'FAQ', sort_order: 1 },
  { vertical_id: 'real-estate', title: 'Selling Your Home — What to Expect', content: 'Selling process: 1) Free market analysis to determine listing price. 2) Home preparation and staging recommendations. 3) Professional photography and virtual tour. 4) MLS listing and marketing campaign. 5) Showings and open houses. 6) Offer review and negotiation. 7) Buyer inspections and appraisal. 8) Closing. Typical time on market: 15-45 days depending on market conditions. Commission structure discussed at listing appointment.', category_type: 'FAQ', sort_order: 2 },
  { vertical_id: 'real-estate', title: 'Rental Property Services', content: 'For renters: We list available rental properties on our website and major platforms. Application process: complete application, credit/background check ($35-$50 fee), income verification (typically 3x rent), references. For landlords: We offer tenant placement ($500-$1,000 or one month\'s rent) and full property management (8-12% of monthly rent) including tenant screening, rent collection, and maintenance coordination.', category_type: 'Services', sort_order: 3 },
  { vertical_id: 'real-estate', title: 'Mortgage Pre-Approval Guide', content: 'Pre-approval shows sellers you\'re a serious buyer. Required documents: last 2 years of tax returns, recent pay stubs, 2-3 months of bank statements, employment verification, photo ID. Typical requirements: credit score 620+ (conventional), 580+ (FHA). Down payment: 3-20% (conventional), 3.5% (FHA), 0% (VA/USDA). Pre-approval is usually valid for 60-90 days. We can recommend trusted mortgage lenders in our network.', category_type: 'FAQ', sort_order: 4 },
  { vertical_id: 'real-estate', title: 'Home Inspection — What It Covers', content: 'A standard home inspection covers: structural components (foundation, framing), exterior (siding, roof, gutters), plumbing systems, electrical systems, HVAC, interior (walls, ceilings, floors, doors, windows), insulation and ventilation, and built-in appliances. Does NOT cover: environmental hazards (mold, radon, lead — separate testing), pest/termite (separate inspection), swimming pools, wells, septic. Cost: $300-$600 depending on home size.', category_type: 'FAQ', sort_order: 5 },
  { vertical_id: 'real-estate', title: 'Making an Offer', content: 'Key elements of a purchase offer: purchase price, earnest money deposit (1-3% of purchase price), financing type and terms, contingencies (inspection, appraisal, financing), requested closing date, items included/excluded (appliances, fixtures), and any special terms. In competitive markets, consider: escalation clauses, shortened contingency periods, flexible closing dates. Your agent will advise on competitive offer strategies for the current market.', category_type: 'Procedures', sort_order: 6 },
  { vertical_id: 'real-estate', title: 'Open House and Showing Information', content: 'Open houses are typically held on weekends, 1:00 PM - 4:00 PM. Private showings can be scheduled through your agent. Showing etiquette: remove shoes if requested, keep children supervised, don\'t open closed doors without permission, ask before taking photos. Virtual tours available for most listings on our website. For vacant properties, lockbox access is arranged through your agent. 24-hour notice required for occupied properties.', category_type: 'FAQ', sort_order: 7 },
  { vertical_id: 'real-estate', title: 'Closing Costs Breakdown', content: 'Typical buyer closing costs (2-5% of purchase price): loan origination fee, appraisal, title insurance and search, attorney fees, recording fees, prepaid items (taxes, insurance, interest). Typical seller closing costs: agent commissions, title insurance, transfer taxes, attorney fees, prorated taxes. Some closing costs are negotiable. Ask your agent about seller concessions in buyer\'s markets.', category_type: 'FAQ', sort_order: 8 },
  { vertical_id: 'real-estate', title: 'Neighborhoods and Market Data', content: 'When asked about neighborhoods, provide: school district ratings, average home prices, recent sales data, proximity to amenities (shopping, dining, parks, transit), community features (HOA, pool, walking trails), growth trends and development plans. Market data: average days on market, list-to-sale price ratio, inventory levels, and year-over-year price changes. Always note that neighborhoods should be visited in person to get a true feel.', category_type: 'FAQ', sort_order: 9 },
  { vertical_id: 'real-estate', title: 'First-Time Homebuyer Programs', content: 'Common first-time buyer programs: FHA loans (3.5% down, lower credit requirements), VA loans (0% down for veterans and active military), USDA loans (0% down for rural areas), state-specific down payment assistance programs, and first-time buyer tax credits. Some programs have income limits and property location requirements. Our agents specialize in guiding first-time buyers through available programs.', category_type: 'Services', sort_order: 10 },
  { vertical_id: 'real-estate', title: 'Agent Matching Process', content: 'We match you with an agent based on: 1) The area or neighborhood you\'re interested in. 2) Whether you\'re buying, selling, or renting. 3) Your price range. 4) Specialized needs (luxury, investment, first-time buyer, relocation). 5) Language preferences. 6) Agent availability. Our team includes [X] agents covering [areas]. All agents are licensed and carry E&O insurance. Agent interviews are welcome before committing.', category_type: 'Services', sort_order: 11 },
  { vertical_id: 'real-estate', title: 'Real Estate Escalation Rules', content: 'Agent immediate notification: offer received or deadline approaching, buyer wants to submit an offer, showing request for listed property. Broker escalation: contract dispute, dual agency situation, fair housing concern, client complaint. Immediate escalation: closing scheduled within 48 hours with unresolved issues, earnest money dispute, potential fraud indicators. Never provide opinions on property values without a formal analysis.', category_type: 'Procedures', sort_order: 12 },

  // ── Insurance (12 articles) ──
  { vertical_id: 'insurance', title: 'Insurance Products Overview', content: 'We offer comprehensive insurance coverage including: Auto Insurance (liability, collision, comprehensive, uninsured motorist), Homeowners Insurance (dwelling, personal property, liability, loss of use), Renters Insurance, Life Insurance (term, whole, universal), Business Insurance (general liability, BOP, workers comp, professional liability), Umbrella Insurance, and Health Insurance marketplace assistance. Multiple carrier options for competitive rates.', category_type: 'Services', sort_order: 1 },
  { vertical_id: 'insurance', title: 'How to File a Claim', content: 'Claims process: 1) Report the incident to us by phone or online portal. 2) Provide date, time, location, and description of what happened. 3) Gather documentation: police reports, photos of damage, medical records if applicable. 4) We file the claim with your carrier. 5) An adjuster is assigned and will contact you within 1-3 business days. 6) Adjuster inspects damage and provides estimate. 7) Claim is settled and payment issued. Keep all receipts for expenses.', category_type: 'Procedures', sort_order: 2 },
  { vertical_id: 'insurance', title: 'Auto Insurance Coverage Explained', content: 'Auto coverage types: Liability (required by law — covers damage you cause to others; bodily injury and property damage). Collision (covers damage to your car in an accident). Comprehensive (covers theft, vandalism, weather, animals). Uninsured/Underinsured Motorist (protects you when the other driver lacks adequate coverage). Medical Payments/PIP (covers medical bills regardless of fault). Deductible: the amount you pay before insurance kicks in, typically $250-$1,000.', category_type: 'FAQ', sort_order: 3 },
  { vertical_id: 'insurance', title: 'Homeowners Insurance Basics', content: 'Standard homeowners policies cover: Dwelling (the structure), Other Structures (garage, fence), Personal Property (belongings — typically 50-70% of dwelling coverage), Loss of Use (living expenses if displaced), Personal Liability (lawsuits), Medical Payments to Others. NOT typically covered: flooding (requires separate flood policy), earthquakes, maintenance issues, sewer backup (available as endorsement). Review coverage annually to ensure adequate protection.', category_type: 'FAQ', sort_order: 4 },
  { vertical_id: 'insurance', title: 'Getting a Quote — What We Need', content: 'For an auto quote: driver\'s license numbers, vehicle VINs, current insurance declarations page, driving history. For a home quote: property address, year built, square footage, construction type, roof age and material, claims history, desired coverage levels. For life insurance: age, health history, height/weight, tobacco use, desired coverage amount and term. Quotes are free and typically provided within 1 business day. Online quoting available for auto and home.', category_type: 'Procedures', sort_order: 5 },
  { vertical_id: 'insurance', title: 'Policy Changes and Endorsements', content: 'Common policy changes we handle: adding or removing a vehicle, adding a driver (new teen driver, spouse), updating address, changing coverage levels, adding endorsements (jewelry rider, sewer backup, identity theft). Most changes take effect immediately or next business day. Some changes may affect your premium — we\'ll provide the updated cost before making changes. Annual policy reviews are recommended.', category_type: 'Services', sort_order: 6 },
  { vertical_id: 'insurance', title: 'Discounts and Savings', content: 'Available discounts: Multi-policy (bundle home + auto for 10-25% savings), good driver, accident-free, good student (under 25 with B average), defensive driving course, vehicle safety features, home security system, new home, claims-free, loyalty, paperless billing, autopay. Not all discounts are available from all carriers. We shop multiple carriers to find the best combination of coverage and price.', category_type: 'FAQ', sort_order: 7 },
  { vertical_id: 'insurance', title: 'What to Do After an Auto Accident', content: 'Steps after an accident: 1) Check for injuries — call 911 if needed. 2) Move to a safe location if possible. 3) Exchange information with other drivers (name, insurance, license plate). 4) Document the scene — photos of all vehicles, road conditions, traffic signs. 5) Get a police report if there are injuries or significant damage. 6) Do NOT admit fault. 7) Contact us to file a claim. 8) Seek medical attention even for minor symptoms. Time is important for documentation.', category_type: 'Procedures', sort_order: 8 },
  { vertical_id: 'insurance', title: 'Life Insurance Options', content: 'Term Life: coverage for a set period (10, 20, 30 years), most affordable option, ideal for income replacement and mortgage protection. Whole Life: permanent coverage with cash value accumulation, level premiums, can borrow against cash value. Universal Life: flexible premiums and death benefit, cash value earns interest. General rule of thumb: coverage should be 10-15x annual income. Rates are best when you\'re young and healthy. Medical exam may be required.', category_type: 'Services', sort_order: 9 },
  { vertical_id: 'insurance', title: 'Billing and Payment Options', content: 'Payment options: monthly, quarterly, semi-annual, or annual (annual pay saves 5-10%). Methods: auto-draft from bank account, credit/debit card, online portal, mail-in check. Policy cancels for non-payment after grace period (typically 10-30 days depending on state and carrier). Reinstatement may be possible within 30 days of lapse. Contact us immediately if you\'re having difficulty making payments — we may be able to adjust coverage to reduce costs.', category_type: 'FAQ', sort_order: 10 },
  { vertical_id: 'insurance', title: 'Understanding Your Declarations Page', content: 'Your declarations page (dec page) is the summary of your policy. It shows: policy number, effective dates, named insureds, property or vehicles covered, coverage types and limits, deductibles, premium breakdown, mortgagee or lienholder information. Keep a copy easily accessible. Digital copies available in your online portal. This is the document lenders and landlords typically request as proof of insurance.', category_type: 'FAQ', sort_order: 11 },
  { vertical_id: 'insurance', title: 'Insurance Call Escalation Rules', content: 'Claims team immediate: accident just occurred, property damage in progress (fire, storm, break-in), injury being reported. Agent callback (same day): coverage questions, quote requests, policy change requests. Manager escalation: billing dispute, claim denial complaint, cancellation request citing dissatisfaction, regulatory complaint. Carrier escalation: claim over authority level, suspected fraud, subrogation issues. Never advise a customer that something "should be covered" without verification.', category_type: 'Procedures', sort_order: 12 },
];

const demoFlows: DemoFlow[] = [
  // ── HVAC ──
  {
    vertical_id: 'hvac',
    scenario_name: 'Emergency No Heat Call',
    caller_request: 'Hi, our furnace stopped working and it\'s 15 degrees outside. We have small children at home. Can someone come out immediately?',
    expected_agent_path: [
      { step: 1, action: 'greet', description: 'Greet the caller and acknowledge the urgency' },
      { step: 2, action: 'qualify', description: 'Confirm this is a no-heat emergency with freezing temperatures and children present' },
      { step: 3, action: 'troubleshoot', description: 'Quick check: ask about thermostat settings, check if pilot light is on, any error codes' },
      { step: 4, action: 'escalate', description: 'If not resolved, flag as emergency and dispatch on-call technician' },
      { step: 5, action: 'schedule', description: 'Book emergency service call and provide ETA' },
    ],
    expected_tool_calls: [
      { tool: 'bookServiceAppointment', params: { priority: 'emergency', service_type: 'no_heat', timeframe: 'immediate' } },
      { tool: 'sendNotification', params: { type: 'emergency_dispatch', target: 'on_call_technician' } },
    ],
  },
  {
    vertical_id: 'hvac',
    scenario_name: 'Routine AC Tune-Up Request',
    caller_request: 'I\'d like to schedule my annual AC tune-up before summer starts.',
    expected_agent_path: [
      { step: 1, action: 'greet', description: 'Greet the caller warmly' },
      { step: 2, action: 'qualify', description: 'Confirm system type and last maintenance date' },
      { step: 3, action: 'schedule', description: 'Offer available time slots for routine maintenance' },
    ],
    expected_tool_calls: [
      { tool: 'bookServiceAppointment', params: { priority: 'routine', service_type: 'ac_tuneup' } },
    ],
  },

  // ── Plumbing ──
  {
    vertical_id: 'plumbing',
    scenario_name: 'Burst Pipe Emergency',
    caller_request: 'We have a burst pipe in our basement and water is flooding everywhere! What do we do?',
    expected_agent_path: [
      { step: 1, action: 'greet', description: 'Greet and immediately acknowledge the emergency' },
      { step: 2, action: 'troubleshoot', description: 'Instruct caller to locate and shut off main water valve immediately' },
      { step: 3, action: 'escalate', description: 'Flag as emergency — active flooding' },
      { step: 4, action: 'schedule', description: 'Dispatch emergency plumber and provide ETA' },
    ],
    expected_tool_calls: [
      { tool: 'bookServiceAppointment', params: { priority: 'emergency', service_type: 'burst_pipe', timeframe: 'immediate' } },
      { tool: 'sendNotification', params: { type: 'emergency_dispatch', target: 'on_call_plumber' } },
    ],
  },

  // ── Dental ──
  {
    vertical_id: 'dental',
    scenario_name: 'New Patient Appointment',
    caller_request: 'I just moved to the area and need to find a new dentist. I\'d like to schedule a cleaning and checkup.',
    expected_agent_path: [
      { step: 1, action: 'greet', description: 'Welcome the new patient warmly' },
      { step: 2, action: 'qualify', description: 'Confirm new patient, ask about insurance, any specific concerns' },
      { step: 3, action: 'schedule', description: 'Book new patient exam and cleaning (90 min slot), instruct to arrive 15 min early' },
    ],
    expected_tool_calls: [
      { tool: 'scheduleDentalAppointment', params: { type: 'new_patient_exam', duration: 90 } },
    ],
  },
  {
    vertical_id: 'dental',
    scenario_name: 'Dental Emergency — Knocked Out Tooth',
    caller_request: 'My child just knocked out a permanent tooth playing sports. It happened about 10 minutes ago. What should I do?',
    expected_agent_path: [
      { step: 1, action: 'greet', description: 'Acknowledge urgency immediately' },
      { step: 2, action: 'troubleshoot', description: 'Instruct: handle tooth by crown, rinse gently, try to re-implant or store in milk. Time is critical.' },
      { step: 3, action: 'escalate', description: 'This is a dental emergency — page on-call dentist and book immediate appointment' },
      { step: 4, action: 'schedule', description: 'Schedule emergency visit within the hour' },
    ],
    expected_tool_calls: [
      { tool: 'scheduleDentalAppointment', params: { type: 'emergency', priority: 'immediate' } },
      { tool: 'sendNotification', params: { type: 'emergency_page', target: 'on_call_dentist' } },
    ],
  },

  // ── Medical After Hours ──
  {
    vertical_id: 'medical-after-hours',
    scenario_name: 'Child with High Fever After Hours',
    caller_request: 'My 2-year-old has a fever of 104 and it\'s been going on for a few hours. Our doctor\'s office is closed.',
    expected_agent_path: [
      { step: 1, action: 'greet', description: 'Greet and screen for emergency symptoms' },
      { step: 2, action: 'qualify', description: 'Gather details: child age, temperature, duration, other symptoms, medications given' },
      { step: 3, action: 'troubleshoot', description: 'Provide comfort measures (cool compress, fluids, age-appropriate fever reducer if not already given)' },
      { step: 4, action: 'escalate', description: 'Page on-call pediatrician — high fever in toddler warrants provider assessment' },
    ],
    expected_tool_calls: [
      { tool: 'pageOnCallProvider', params: { urgency: 'urgent', reason: 'pediatric_high_fever', patient_age: 2 } },
      { tool: 'createAfterHoursTicket', params: { type: 'urgent_triage', category: 'pediatric' } },
    ],
  },

  // ── Property Management ──
  {
    vertical_id: 'property-management',
    scenario_name: 'After-Hours Water Leak Report',
    caller_request: 'Water is leaking from my ceiling and it\'s getting worse. I think there\'s a pipe issue from the unit above me.',
    expected_agent_path: [
      { step: 1, action: 'greet', description: 'Greet and acknowledge the concern' },
      { step: 2, action: 'qualify', description: 'Collect unit number, location of leak, severity, and any damage' },
      { step: 3, action: 'troubleshoot', description: 'Ask if they can place containers to catch water, move valuables away from leak area' },
      { step: 4, action: 'escalate', description: 'Dispatch emergency maintenance — active water leak is Priority 1' },
    ],
    expected_tool_calls: [
      { tool: 'createMaintenanceRequest', params: { priority: 'emergency', type: 'water_leak', source: 'ceiling' } },
      { tool: 'sendNotification', params: { type: 'emergency_maintenance', target: 'maintenance_team' } },
    ],
  },

  // ── Legal ──
  {
    vertical_id: 'legal',
    scenario_name: 'New Personal Injury Inquiry',
    caller_request: 'I was in a car accident two weeks ago and the other driver\'s insurance is giving me the runaround. I think I need a lawyer.',
    expected_agent_path: [
      { step: 1, action: 'greet', description: 'Greet and express concern for their situation' },
      { step: 2, action: 'qualify', description: 'Determine case type (PI/auto), accident date, injuries, insurance status, and if they\'ve spoken to the other insurance company' },
      { step: 3, action: 'schedule', description: 'Schedule free personal injury consultation (no upfront cost for PI cases)' },
    ],
    expected_tool_calls: [
      { tool: 'scheduleConsultation', params: { practice_area: 'personal_injury', fee_type: 'free_consultation' } },
      { tool: 'runConflictCheck', params: { parties: ['caller', 'other_driver'] } },
    ],
  },

  // ── Restaurants ──
  {
    vertical_id: 'restaurants',
    scenario_name: 'Large Party Reservation with Dietary Needs',
    caller_request: 'I\'d like to make a reservation for 12 people this Saturday evening. Two guests are vegan and one has a severe nut allergy.',
    expected_agent_path: [
      { step: 1, action: 'greet', description: 'Welcome and express excitement about the reservation' },
      { step: 2, action: 'qualify', description: 'Confirm party size (12 — requires large party policy), date, time preference, dietary needs' },
      { step: 3, action: 'schedule', description: 'Book reservation, note dietary restrictions, inform about large party deposit/pre-fixe requirement if applicable' },
    ],
    expected_tool_calls: [
      { tool: 'makeReservation', params: { party_size: 12, dietary_notes: ['vegan_x2', 'nut_allergy_severe'], type: 'large_party' } },
    ],
  },

  // ── Real Estate ──
  {
    vertical_id: 'real-estate',
    scenario_name: 'First-Time Homebuyer Inquiry',
    caller_request: 'My partner and I are thinking about buying our first home. We\'re not sure where to start or what we can afford.',
    expected_agent_path: [
      { step: 1, action: 'greet', description: 'Warmly congratulate them on considering homeownership' },
      { step: 2, action: 'qualify', description: 'Ask about desired area, budget, pre-approval status, timeline, and specific needs' },
      { step: 3, action: 'troubleshoot', description: 'Explain the buying process, recommend getting pre-approved first, mention first-time buyer programs' },
      { step: 4, action: 'schedule', description: 'Schedule a buyer consultation with an agent who specializes in first-time buyers' },
    ],
    expected_tool_calls: [
      { tool: 'matchAgent', params: { specialization: 'first_time_buyer', inquiry_type: 'buying' } },
      { tool: 'scheduleConsultation', params: { type: 'buyer_consultation' } },
    ],
  },

  // ── Insurance ──
  {
    vertical_id: 'insurance',
    scenario_name: 'Auto Accident Claim Filing',
    caller_request: 'I was just rear-ended at a stoplight about an hour ago. Nobody is seriously hurt but my bumper is smashed. I need to file a claim.',
    expected_agent_path: [
      { step: 1, action: 'greet', description: 'Express concern, confirm everyone is safe' },
      { step: 2, action: 'qualify', description: 'Collect: policy number, accident details (time, location, description), other driver info, police report filed?' },
      { step: 3, action: 'troubleshoot', description: 'Walk through documentation steps: photos, witness info, don\'t admit fault' },
      { step: 4, action: 'escalate', description: 'Initiate the claim with the carrier and provide claim number and adjuster timeline' },
    ],
    expected_tool_calls: [
      { tool: 'fileClaim', params: { type: 'auto_collision', severity: 'moderate', injuries: false } },
      { tool: 'sendNotification', params: { type: 'new_claim', target: 'claims_adjuster' } },
    ],
  },
];

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: existingPrompts } = await client.query('SELECT COUNT(*) AS cnt FROM vertical_prompt_library');
    if (parseInt(existingPrompts[0].cnt) > 0) {
      console.log('Prompt library already seeded, clearing existing data for re-seed...');
      await client.query('DELETE FROM vertical_prompt_library');
    }

    const { rows: existingKnowledge } = await client.query('SELECT COUNT(*) AS cnt FROM vertical_starter_knowledge');
    if (parseInt(existingKnowledge[0].cnt) > 0) {
      console.log('Starter knowledge already seeded, clearing existing data for re-seed...');
      await client.query('DELETE FROM vertical_starter_knowledge');
    }

    const { rows: existingDemos } = await client.query('SELECT COUNT(*) AS cnt FROM vertical_demo_flows');
    if (parseInt(existingDemos[0].cnt) > 0) {
      console.log('Demo flows already seeded, clearing existing data for re-seed...');
      await client.query('DELETE FROM vertical_demo_flows');
    }

    console.log('Seeding prompt library...');
    for (const p of promptLibrary) {
      await client.query(
        `INSERT INTO vertical_prompt_library (vertical_id, category, prompt_text, version) VALUES ($1, $2, $3, 1)`,
        [p.vertical_id, p.category, p.prompt_text],
      );
    }
    console.log(`  Inserted ${promptLibrary.length} prompt entries across ${VERTICALS.length} verticals`);

    console.log('Seeding starter knowledge...');
    for (const k of starterKnowledge) {
      await client.query(
        `INSERT INTO vertical_starter_knowledge (vertical_id, title, content, category_type, sort_order) VALUES ($1, $2, $3, $4, $5)`,
        [k.vertical_id, k.title, k.content, k.category_type, k.sort_order],
      );
    }
    console.log(`  Inserted ${starterKnowledge.length} knowledge articles across ${VERTICALS.length} verticals`);

    console.log('Seeding demo flows...');
    for (const d of demoFlows) {
      await client.query(
        `INSERT INTO vertical_demo_flows (vertical_id, scenario_name, caller_request, expected_agent_path, expected_tool_calls) VALUES ($1, $2, $3, $4, $5)`,
        [d.vertical_id, d.scenario_name, d.caller_request, JSON.stringify(d.expected_agent_path), JSON.stringify(d.expected_tool_calls)],
      );
    }
    console.log(`  Inserted ${demoFlows.length} demo flows`);

    await client.query('COMMIT');
    console.log('Vertical prompt library seeding complete!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seeding failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
