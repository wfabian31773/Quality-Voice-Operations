import { normalizeAgentLanguage, DEFAULT_AGENT_LANGUAGE } from './agentLanguages';

/**
 * Localized greeting templates for each per-template default greeting. Each
 * entry maps a 2-letter language code (matching `AGENT_LANGUAGES`) to a string
 * template. The `{name}` placeholder is interpolated with the practice / firm
 * / company name supplied by the agent's metadata.
 */
type LocalizedTemplates = Readonly<Record<string, string>>;

export type GreetingTemplateKey =
  | 'dental'
  | 'property-management'
  | 'home-services'
  | 'legal'
  | 'customer-support'
  | 'outbound-sales'
  | 'technical-support'
  | 'collections'
  | 'medical-after-hours'
  | 'answering-service';

const GREETING_TRANSLATIONS: Readonly<Record<GreetingTemplateKey, LocalizedTemplates>> = {
  dental: {
    en: 'Thank you for calling {name}. How can I help you today?',
    es: 'Gracias por llamar a {name}. ¿Cómo puedo ayudarle hoy?',
    fr: "Merci d'appeler {name}. Comment puis-je vous aider aujourd'hui ?",
    de: 'Vielen Dank für Ihren Anruf bei {name}. Wie kann ich Ihnen heute helfen?',
    pt: 'Obrigado por ligar para {name}. Como posso ajudá-lo hoje?',
    it: 'Grazie per aver chiamato {name}. Come posso aiutarla oggi?',
    nl: 'Bedankt voor uw oproep naar {name}. Hoe kan ik u vandaag helpen?',
    zh: '感谢您致电{name}。今天我能为您做些什么?',
    ja: '{name}にお電話いただきありがとうございます。本日はどのようなご用件でしょうか?',
    ko: '{name}에 전화해 주셔서 감사합니다. 오늘 어떻게 도와드릴까요?',
    ar: 'شكرًا لاتصالك بـ {name}. كيف يمكنني مساعدتك اليوم؟',
    hi: '{name} को कॉल करने के लिए धन्यवाद। आज मैं आपकी कैसे मदद कर सकता हूँ?',
  },
  'property-management': {
    en: 'Thank you for calling {name}. How can I assist you today?',
    es: 'Gracias por llamar a {name}. ¿En qué puedo asistirle hoy?',
    fr: "Merci d'appeler {name}. Comment puis-je vous assister aujourd'hui ?",
    de: 'Vielen Dank für Ihren Anruf bei {name}. Wie kann ich Ihnen heute behilflich sein?',
    pt: 'Obrigado por ligar para {name}. Como posso ajudá-lo hoje?',
    it: 'Grazie per aver chiamato {name}. Come posso assisterla oggi?',
    nl: 'Bedankt voor uw oproep naar {name}. Hoe kan ik u vandaag van dienst zijn?',
    zh: '感谢您致电{name}。今天我可以为您提供什么帮助?',
    ja: '{name}にお電話いただきありがとうございます。本日はどのようなご用件でしょうか?',
    ko: '{name}에 전화해 주셔서 감사합니다. 오늘 어떻게 도와드릴까요?',
    ar: 'شكرًا لاتصالك بـ {name}. كيف يمكنني مساعدتك اليوم؟',
    hi: '{name} को कॉल करने के लिए धन्यवाद। आज मैं आपकी कैसे सहायता कर सकता हूँ?',
  },
  'home-services': {
    en: 'Thank you for calling {name}. How can we help you today?',
    es: 'Gracias por llamar a {name}. ¿Cómo podemos ayudarle hoy?',
    fr: "Merci d'appeler {name}. Comment pouvons-nous vous aider aujourd'hui ?",
    de: 'Vielen Dank für Ihren Anruf bei {name}. Wie können wir Ihnen heute helfen?',
    pt: 'Obrigado por ligar para {name}. Como podemos ajudá-lo hoje?',
    it: 'Grazie per aver chiamato {name}. Come possiamo aiutarla oggi?',
    nl: 'Bedankt voor uw oproep naar {name}. Hoe kunnen wij u vandaag helpen?',
    zh: '感谢您致电{name}。我们今天能为您做些什么?',
    ja: '{name}にお電話いただきありがとうございます。本日はどのようなご用件でしょうか?',
    ko: '{name}에 전화해 주셔서 감사합니다. 오늘 무엇을 도와드릴까요?',
    ar: 'شكرًا لاتصالك بـ {name}. كيف يمكننا مساعدتك اليوم؟',
    hi: '{name} को कॉल करने के लिए धन्यवाद। आज हम आपकी कैसे मदद कर सकते हैं?',
  },
  legal: {
    en: 'Thank you for calling {name}. How may I assist you?',
    es: 'Gracias por llamar a {name}. ¿En qué puedo asistirle?',
    fr: "Merci d'appeler {name}. Comment puis-je vous assister ?",
    de: 'Vielen Dank für Ihren Anruf bei {name}. Wie kann ich Ihnen behilflich sein?',
    pt: 'Obrigado por ligar para {name}. Como posso ajudá-lo?',
    it: 'Grazie per aver chiamato {name}. Come posso assisterla?',
    nl: 'Bedankt voor uw oproep naar {name}. Hoe kan ik u van dienst zijn?',
    zh: '感谢您致电{name}。我能为您提供什么帮助?',
    ja: '{name}にお電話いただきありがとうございます。どのようなご用件でしょうか?',
    ko: '{name}에 전화해 주셔서 감사합니다. 어떻게 도와드릴까요?',
    ar: 'شكرًا لاتصالك بـ {name}. كيف يمكنني مساعدتك؟',
    hi: '{name} को कॉल करने के लिए धन्यवाद। मैं आपकी कैसे सहायता कर सकता हूँ?',
  },
  'customer-support': {
    en: 'Thank you for calling {name} support. How can I help you today?',
    es: 'Gracias por llamar a soporte de {name}. ¿Cómo puedo ayudarle hoy?',
    fr: "Merci d'appeler le support {name}. Comment puis-je vous aider aujourd'hui ?",
    de: 'Vielen Dank für Ihren Anruf beim {name}-Support. Wie kann ich Ihnen heute helfen?',
    pt: 'Obrigado por ligar para o suporte da {name}. Como posso ajudá-lo hoje?',
    it: 'Grazie per aver chiamato il supporto {name}. Come posso aiutarla oggi?',
    nl: 'Bedankt voor uw oproep naar de {name}-support. Hoe kan ik u vandaag helpen?',
    zh: '感谢您致电{name}客户支持。今天我能为您做些什么?',
    ja: '{name}サポートにお電話いただきありがとうございます。本日はどのようなご用件でしょうか?',
    ko: '{name} 고객지원에 전화해 주셔서 감사합니다. 오늘 어떻게 도와드릴까요?',
    ar: 'شكرًا لاتصالك بدعم {name}. كيف يمكنني مساعدتك اليوم؟',
    hi: '{name} सपोर्ट को कॉल करने के लिए धन्यवाद। आज मैं आपकी कैसे मदद कर सकता हूँ?',
  },
  'outbound-sales': {
    en: 'Hi, this is a representative from {name}. Is now a good time to chat?',
    es: 'Hola, soy un representante de {name}. ¿Es un buen momento para hablar?',
    fr: 'Bonjour, je suis un représentant de {name}. Est-ce un bon moment pour discuter ?',
    de: 'Hallo, ich bin ein Vertreter von {name}. Passt es Ihnen gerade zu sprechen?',
    pt: 'Olá, sou um representante da {name}. É um bom momento para conversar?',
    it: 'Salve, sono un rappresentante di {name}. È un buon momento per parlare?',
    nl: 'Hallo, ik ben een vertegenwoordiger van {name}. Is dit een goed moment om te praten?',
    zh: '您好,我是{name}的代表。现在方便聊几分钟吗?',
    ja: 'こんにちは、{name}の担当者です。今お話ししてもよろしいでしょうか?',
    ko: '안녕하세요, {name}의 담당자입니다. 지금 잠시 통화 가능하실까요?',
    ar: 'مرحبًا، أنا ممثل من {name}. هل هذا وقت مناسب للتحدث؟',
    hi: 'नमस्ते, मैं {name} का प्रतिनिधि हूँ। क्या अभी बात करने का सही समय है?',
  },
  'technical-support': {
    en: 'Thank you for calling {name} technical support. How can I assist you?',
    es: 'Gracias por llamar al soporte técnico de {name}. ¿En qué puedo asistirle?',
    fr: "Merci d'appeler le support technique {name}. Comment puis-je vous assister ?",
    de: 'Vielen Dank für Ihren Anruf beim technischen Support von {name}. Wie kann ich Ihnen behilflich sein?',
    pt: 'Obrigado por ligar para o suporte técnico da {name}. Como posso ajudá-lo?',
    it: 'Grazie per aver chiamato il supporto tecnico {name}. Come posso assisterla?',
    nl: 'Bedankt voor uw oproep naar de technische ondersteuning van {name}. Hoe kan ik u van dienst zijn?',
    zh: '感谢您致电{name}技术支持。我能为您提供什么帮助?',
    ja: '{name}テクニカルサポートにお電話いただきありがとうございます。どのようなご用件でしょうか?',
    ko: '{name} 기술지원에 전화해 주셔서 감사합니다. 어떻게 도와드릴까요?',
    ar: 'شكرًا لاتصالك بالدعم الفني لـ {name}. كيف يمكنني مساعدتك؟',
    hi: '{name} तकनीकी सहायता को कॉल करने के लिए धन्यवाद। मैं आपकी कैसे सहायता कर सकता हूँ?',
  },
  collections: {
    en: 'Hello, this is a representative from {name}. This is an attempt to collect a debt. Any information obtained will be used for that purpose. May I speak with the account holder?',
    es: 'Hola, soy un representante de {name}. Esta es una gestión para cobrar una deuda. Cualquier información obtenida se utilizará para ese fin. ¿Puedo hablar con el titular de la cuenta?',
    fr: "Bonjour, je suis un représentant de {name}. Ceci est une tentative de recouvrement de créance. Toute information obtenue sera utilisée à cette fin. Puis-je parler au titulaire du compte ?",
    de: 'Hallo, ich bin ein Vertreter von {name}. Dies ist ein Versuch, eine Forderung einzuziehen. Alle erhaltenen Informationen werden zu diesem Zweck verwendet. Darf ich mit dem Kontoinhaber sprechen?',
    pt: 'Olá, sou um representante da {name}. Esta é uma tentativa de cobrança de dívida. Qualquer informação obtida será usada para esse fim. Posso falar com o titular da conta?',
    it: 'Salve, sono un rappresentante di {name}. Questo è un tentativo di riscossione di un debito. Le informazioni ottenute saranno utilizzate a tale scopo. Posso parlare con il titolare del conto?',
    nl: 'Hallo, ik ben een vertegenwoordiger van {name}. Dit is een poging om een schuld te innen. Alle verkregen informatie wordt voor dat doel gebruikt. Mag ik de rekeninghouder spreken?',
    zh: '您好,我是{name}的代表。本次通话旨在催收一笔债务,获取的任何信息都将用于此目的。请问可以与账户持有人通话吗?',
    ja: 'こんにちは、{name}の担当者です。本通話は債権回収のためのものであり、取得したすべての情報はその目的に使用されます。口座名義人とお話しできますでしょうか?',
    ko: '안녕하세요, {name}의 담당자입니다. 본 통화는 채무 회수를 위한 것이며, 취득한 모든 정보는 그 목적으로 사용됩니다. 계정 명의자와 통화할 수 있을까요?',
    ar: 'مرحبًا، أنا ممثل من {name}. هذه محاولة لتحصيل دين. أي معلومات يتم الحصول عليها ستُستخدم لهذا الغرض. هل يمكنني التحدث مع صاحب الحساب؟',
    hi: 'नमस्ते, मैं {name} का प्रतिनिधि हूँ। यह एक ऋण वसूली का प्रयास है। प्राप्त की गई कोई भी जानकारी उसी उद्देश्य के लिए उपयोग की जाएगी। क्या मैं खाताधारक से बात कर सकता हूँ?',
  },
  'answering-service': {
    en: 'Thank you for calling {name}. How can I help you today?',
    es: 'Gracias por llamar a {name}. ¿Cómo puedo ayudarle hoy?',
    fr: "Merci d'appeler {name}. Comment puis-je vous aider aujourd'hui ?",
    de: 'Vielen Dank für Ihren Anruf bei {name}. Wie kann ich Ihnen heute helfen?',
    pt: 'Obrigado por ligar para {name}. Como posso ajudá-lo hoje?',
    it: 'Grazie per aver chiamato {name}. Come posso aiutarla oggi?',
    nl: 'Bedankt voor uw oproep naar {name}. Hoe kan ik u vandaag helpen?',
    zh: '感谢您致电{name}。今天我能为您做些什么?',
    ja: '{name}にお電話いただきありがとうございます。本日はどのようなご用件でしょうか?',
    ko: '{name}에 전화해 주셔서 감사합니다. 오늘 어떻게 도와드릴까요?',
    ar: 'شكرًا لاتصالك بـ {name}. كيف يمكنني مساعدتك اليوم؟',
    hi: '{name} को कॉल करने के लिए धन्यवाद। आज मैं आपकी कैसे मदद कर सकता हूँ?',
  },
  'medical-after-hours': {
    en: 'Thank you for calling {name}. All of our offices are currently closed. You have reached the after-hours call service. If this is a medical emergency, please dial 911. All calls are recorded for quality assurance. How can I help you?',
    es: 'Gracias por llamar a {name}. Todas nuestras oficinas están cerradas en este momento. Ha comunicado con el servicio de llamadas fuera de horario. Si se trata de una emergencia médica, por favor marque el 911. Todas las llamadas se graban para garantizar la calidad. ¿Cómo puedo ayudarle?',
    fr: "Merci d'appeler {name}. Tous nos bureaux sont actuellement fermés. Vous avez joint le service d'appels en dehors des heures d'ouverture. En cas d'urgence médicale, veuillez composer le 911. Tous les appels sont enregistrés pour garantir la qualité. Comment puis-je vous aider ?",
    de: 'Vielen Dank für Ihren Anruf bei {name}. Alle unsere Büros sind derzeit geschlossen. Sie haben den Anrufdienst außerhalb der Geschäftszeiten erreicht. Im medizinischen Notfall wählen Sie bitte den Notruf 911. Alle Anrufe werden zur Qualitätssicherung aufgezeichnet. Wie kann ich Ihnen helfen?',
    pt: 'Obrigado por ligar para {name}. Todos os nossos escritórios estão fechados no momento. Você ligou para o serviço de atendimento fora do horário comercial. Em caso de emergência médica, ligue para 911. Todas as ligações são gravadas para garantia de qualidade. Como posso ajudá-lo?',
    it: 'Grazie per aver chiamato {name}. Tutti i nostri uffici sono attualmente chiusi. Ha raggiunto il servizio di chiamate fuori orario. In caso di emergenza medica, componga il 911. Tutte le chiamate sono registrate per garantire la qualità. Come posso aiutarla?',
    nl: 'Bedankt voor uw oproep naar {name}. Al onze kantoren zijn momenteel gesloten. U heeft de buiten kantooruren-service bereikt. Bel bij een medisch noodgeval 911. Alle gesprekken worden opgenomen voor kwaliteitsbewaking. Hoe kan ik u helpen?',
    zh: '感谢您致电{name}。我们的所有办公室目前均已关闭。您已接通非工作时间呼叫服务。如果是医疗紧急情况,请拨打911。所有通话均被录音以确保服务质量。我能为您做些什么?',
    ja: '{name}にお電話いただきありがとうございます。現在、すべてのオフィスは閉まっております。時間外コールサービスにおつなぎしています。医療上の緊急事態の場合は911までお電話ください。品質保証のため、すべての通話は録音されています。どのようなご用件でしょうか?',
    ko: '{name}에 전화해 주셔서 감사합니다. 현재 모든 사무실이 운영을 마쳤으며, 시간 외 콜 서비스로 연결되셨습니다. 의료 응급 상황인 경우 911에 전화해 주세요. 품질 보증을 위해 모든 통화가 녹음됩니다. 무엇을 도와드릴까요?',
    ar: 'شكرًا لاتصالك بـ {name}. جميع مكاتبنا مغلقة حاليًا. لقد وصلت إلى خدمة المكالمات خارج ساعات العمل. إذا كانت هذه حالة طبية طارئة، فيرجى الاتصال بالرقم 911. يتم تسجيل جميع المكالمات لضمان الجودة. كيف يمكنني مساعدتك؟',
    hi: '{name} को कॉल करने के लिए धन्यवाद। हमारे सभी कार्यालय अभी बंद हैं। आप आफ्टर-आवर्स कॉल सेवा से जुड़े हैं। यदि यह चिकित्सीय आपातकाल है, तो कृपया 911 डायल करें। गुणवत्ता आश्वासन के लिए सभी कॉल रिकॉर्ड की जाती हैं। मैं आपकी कैसे मदद कर सकता हूँ?',
  },
};

/**
 * Resolve a localized greeting for a per-template default. Falls back to the
 * English template when the requested language is missing or unsupported.
 * The `{name}` placeholder in the template is replaced with the supplied name.
 */
export function buildLocalizedGreeting(
  template: GreetingTemplateKey,
  name: string,
  language?: string,
): string {
  const lang = normalizeAgentLanguage(language);
  const variants = GREETING_TRANSLATIONS[template];
  const tmpl = variants[lang] ?? variants[DEFAULT_AGENT_LANGUAGE];
  return tmpl.replace(/\{name\}/g, name);
}
