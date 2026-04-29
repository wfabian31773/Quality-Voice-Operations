import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ArrowLeft, Calculator, DollarSign, TrendingUp, Clock, Mail, CheckCircle2, Loader2 } from 'lucide-react';
import { trackCTAClick, trackConversionEvent } from '../lib/analytics';
import { CTA } from '../lib/analyticsCtas';
import { formatDollars } from '../lib/formatCurrency';

interface ROICalculatorProps {
  vertical?: string;
}

const DEFAULTS: Record<string, { calls: number; handleTime: number; hourlyRate: number }> = {
  healthcare: { calls: 800, handleTime: 4, hourlyRate: 18 },
  'real-estate': { calls: 400, handleTime: 5, hourlyRate: 20 },
  legal: { calls: 300, handleTime: 6, hourlyRate: 22 },
  'home-services': { calls: 600, handleTime: 5, hourlyRate: 16 },
  dental: { calls: 500, handleTime: 4, hourlyRate: 17 },
};

const QVO_COST_PER_MINUTE = 0.12;
const QVO_MONTHLY_BASE = 99;

export default function ROICalculator({ vertical }: ROICalculatorProps) {
  const defaults = vertical && DEFAULTS[vertical] ? DEFAULTS[vertical] : { calls: 500, handleTime: 5, hourlyRate: 18 };

  const [step, setStep] = useState(0);
  const [monthlyCallVolume, setMonthlyCallVolume] = useState(defaults.calls);
  const [avgHandleTime, setAvgHandleTime] = useState(defaults.handleTime);
  const [agentHourlyCost, setAgentHourlyCost] = useState(defaults.hourlyRate);
  const [aiHandleRate, setAiHandleRate] = useState(70);

  const [emailReport, setEmailReport] = useState({ name: '', email: '', company: '' });
  const [emailStatus, setEmailStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [emailError, setEmailError] = useState<string | null>(null);

  const results = useMemo(() => {
    const aiHandleFraction = Math.min(Math.max(aiHandleRate / 100, 0), 1);
    const totalMinutesPerMonth = monthlyCallVolume * avgHandleTime;
    const aiMinutesPerMonth = totalMinutesPerMonth * aiHandleFraction;
    const totalHoursPerMonth = totalMinutesPerMonth / 60;
    const currentMonthlyCost = totalHoursPerMonth * agentHourlyCost;
    const currentCostPerCall = monthlyCallVolume > 0 ? currentMonthlyCost / monthlyCallVolume : 0;
    const residualHumanCost = currentMonthlyCost * (1 - aiHandleFraction);
    const qvoUsageCost = aiMinutesPerMonth * QVO_COST_PER_MINUTE;
    const qvoMonthlyCost = qvoUsageCost + QVO_MONTHLY_BASE + residualHumanCost;
    const monthlySavings = Math.max(0, currentMonthlyCost - qvoMonthlyCost);
    const annualSavings = monthlySavings * 12;
    const annualROI = qvoMonthlyCost > 0 ? ((monthlySavings * 12) / (qvoMonthlyCost * 12)) * 100 : 0;
    const paybackDays = monthlySavings > 0 ? Math.ceil((qvoMonthlyCost / monthlySavings) * 30) : 0;

    return {
      currentMonthlyCost,
      currentCostPerCall,
      qvoMonthlyCost,
      monthlySavings,
      annualSavings,
      annualROI,
      paybackDays,
      totalMinutesPerMonth,
      aiMinutesPerMonth,
    };
  }, [monthlyCallVolume, avgHandleTime, agentHourlyCost, aiHandleRate]);

  const handleEmailReport = async (e: React.FormEvent) => {
    e.preventDefault();
    setEmailStatus('sending');
    setEmailError(null);
    try {
      const res = await fetch('/api/roi-lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: emailReport.name || null,
          email: emailReport.email,
          company: emailReport.company || null,
          vertical: vertical || null,
          inputs: { monthlyCallVolume, avgHandleTime, agentHourlyCost, aiHandleRate },
          results,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Unable to send report.');
      }
      trackConversionEvent('roi_report_requested', '/roi-calculator', { vertical, savings: Math.round(results.annualSavings) });
      setEmailStatus('sent');
    } catch (err) {
      setEmailStatus('error');
      setEmailError(err instanceof Error ? err.message : 'Something went wrong.');
    }
  };

  const formatCurrency = (value: number) => formatDollars(value, { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  const steps = [
    {
      title: 'Monthly Call Volume',
      description: 'How many calls does your business handle per month?',
      input: (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-500">Calls per month</span>
            <span className="text-2xl font-display font-bold text-sidebar-bg">{monthlyCallVolume.toLocaleString()}</span>
          </div>
          <input
            type="range"
            min={50}
            max={5000}
            step={50}
            value={monthlyCallVolume}
            onChange={(e) => setMonthlyCallVolume(Number(e.target.value))}
            className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-primary"
          />
          <div className="flex justify-between text-xs text-slate-400">
            <span>50</span>
            <span>5,000</span>
          </div>
        </div>
      ),
    },
    {
      title: 'Average Handle Time',
      description: 'How long does each call typically last?',
      input: (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-500">Minutes per call</span>
            <span className="text-2xl font-display font-bold text-sidebar-bg">{avgHandleTime} min</span>
          </div>
          <input
            type="range"
            min={1}
            max={15}
            step={0.5}
            value={avgHandleTime}
            onChange={(e) => setAvgHandleTime(Number(e.target.value))}
            className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-primary"
          />
          <div className="flex justify-between text-xs text-slate-400">
            <span>1 min</span>
            <span>15 min</span>
          </div>
        </div>
      ),
    },
    {
      title: 'Agent Hourly Cost',
      description: 'What do you pay your front desk or call center staff per hour?',
      input: (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-500">Hourly rate</span>
            <span className="text-2xl font-display font-bold text-sidebar-bg">${agentHourlyCost}/hr</span>
          </div>
          <input
            type="range"
            min={10}
            max={50}
            step={1}
            value={agentHourlyCost}
            onChange={(e) => setAgentHourlyCost(Number(e.target.value))}
            className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-primary"
          />
          <div className="flex justify-between text-xs text-slate-400">
            <span>$10/hr</span>
            <span>$50/hr</span>
          </div>
          <p className="text-xs text-slate-500 pt-2 border-t border-slate-100">
            Today this works out to about <span className="font-semibold text-sidebar-bg">{formatCurrency((monthlyCallVolume * avgHandleTime / 60) * agentHourlyCost / Math.max(1, monthlyCallVolume))}</span> per call.
          </p>
        </div>
      ),
    },
    {
      title: 'Calls AI Can Handle',
      description: 'Roughly what share of your calls could a voice agent handle end-to-end? Most operators land between 60% and 85%.',
      input: (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-500">% of calls handled by AI</span>
            <span className="text-2xl font-display font-bold text-sidebar-bg">{aiHandleRate}%</span>
          </div>
          <input
            type="range"
            min={20}
            max={95}
            step={5}
            value={aiHandleRate}
            onChange={(e) => setAiHandleRate(Number(e.target.value))}
            className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-primary"
          />
          <div className="flex justify-between text-xs text-slate-400">
            <span>20%</span>
            <span>95%</span>
          </div>
          <p className="text-xs text-slate-500 pt-2 border-t border-slate-100">
            The remaining {100 - aiHandleRate}% stay with your team — escalations, complex cases, or VIP callers.
          </p>
        </div>
      ),
    },
  ];

  return (
    <div className="max-w-2xl mx-auto">
      <div className="bg-white rounded-2xl border border-slate-200 shadow-lg overflow-hidden">
        {step < steps.length ? (
          <div className="p-8">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                <Calculator className="h-4 w-4 text-primary" />
              </div>
              <div className="flex gap-1.5">
                {steps.map((_, idx) => (
                  <div
                    key={idx}
                    className={`h-1.5 w-8 rounded-full transition-colors ${
                      idx <= step ? 'bg-primary' : 'bg-slate-200'
                    }`}
                  />
                ))}
              </div>
            </div>
            <h3 className="text-xl font-display font-bold text-sidebar-bg mt-6 mb-1">
              {steps[step].title}
            </h3>
            <p className="text-sm text-slate-500 mb-8">{steps[step].description}</p>
            {steps[step].input}
            <div className="flex justify-between mt-8">
              <button
                onClick={() => setStep(step - 1)}
                disabled={step === 0}
                className="flex items-center gap-1 text-sm text-slate-500 hover:text-sidebar-bg disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <ArrowLeft className="h-4 w-4" /> Back
              </button>
              <button
                onClick={() => setStep(step + 1)}
                className="flex items-center gap-2 bg-primary hover:bg-primary-hover text-white px-5 py-2.5 rounded-xl text-sm font-medium transition-colors"
              >
                {step === steps.length - 1 ? 'See My Results' : 'Next'} <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        ) : (
          <div className="p-8">
            <h3 className="text-xl font-display font-bold text-sidebar-bg mb-2">Your Projected Savings</h3>
            <p className="text-sm text-slate-500 mb-8">
              Based on {monthlyCallVolume.toLocaleString()} calls/month at {avgHandleTime} min each (≈{formatCurrency(results.currentCostPerCall)} per call), with QVO handling {aiHandleRate}% of volume.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
              <div className="bg-emerald-50 rounded-xl p-5 text-center">
                <DollarSign className="h-5 w-5 text-emerald-600 mx-auto mb-2" />
                <div className="text-2xl font-display font-bold text-emerald-700">{formatCurrency(results.monthlySavings)}</div>
                <div className="text-xs text-emerald-600 mt-1">Monthly savings</div>
              </div>
              <div className="bg-blue-50 rounded-xl p-5 text-center">
                <TrendingUp className="h-5 w-5 text-blue-600 mx-auto mb-2" />
                <div className="text-2xl font-display font-bold text-blue-700">{Math.round(results.annualROI)}%</div>
                <div className="text-xs text-blue-600 mt-1">Annual ROI</div>
              </div>
              <div className="bg-purple-50 rounded-xl p-5 text-center">
                <Clock className="h-5 w-5 text-purple-600 mx-auto mb-2" />
                <div className="text-2xl font-display font-bold text-purple-700">{results.paybackDays} days</div>
                <div className="text-xs text-purple-600 mt-1">Payback period</div>
              </div>
            </div>

            <div className="bg-slate-50 rounded-xl p-5 mb-8">
              <div className="space-y-3">
                <div className="flex justify-between text-sm">
                  <span className="text-slate-600">Current monthly cost (staff)</span>
                  <span className="font-medium text-sidebar-bg">{formatCurrency(results.currentMonthlyCost)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-slate-600">Current cost per call</span>
                  <span className="font-medium text-sidebar-bg">{formatCurrency(results.currentCostPerCall)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-slate-600">QVO monthly cost (incl. residual staff for {100 - aiHandleRate}%)</span>
                  <span className="font-medium text-primary">{formatCurrency(results.qvoMonthlyCost)}</span>
                </div>
                <div className="border-t border-slate-200 pt-3 flex justify-between text-sm font-semibold">
                  <span className="text-sidebar-bg">Annual savings</span>
                  <span className="text-emerald-600">{formatCurrency(results.annualSavings)}/year</span>
                </div>
              </div>
            </div>

            <div className="bg-surface-secondary/60 border border-border-strong/30 rounded-xl p-5 mb-6">
              {emailStatus === 'sent' ? (
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="h-5 w-5 text-success shrink-0 mt-0.5" />
                  <div>
                    <p className="font-display text-sm font-semibold text-sidebar-bg">Report on the way.</p>
                    <p className="text-xs text-text-primary/60 font-body mt-0.5">
                      We will email a copy of these numbers to {emailReport.email}. A specialist may follow up with a tailored breakdown.
                    </p>
                  </div>
                </div>
              ) : (
                <form onSubmit={handleEmailReport} className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Mail className="h-4 w-4 text-primary" />
                    <p className="font-display text-sm font-semibold text-sidebar-bg">Email me this report</p>
                  </div>
                  <p className="text-xs text-text-primary/60 font-body">
                    Get a PDF-ready snapshot of these numbers plus a deeper breakdown by call type.
                  </p>
                  <div className="grid sm:grid-cols-3 gap-2">
                    <input
                      placeholder="Name"
                      value={emailReport.name}
                      onChange={(e) => setEmailReport({ ...emailReport, name: e.target.value })}
                      className="px-3 py-2 rounded-lg border border-border-strong/40 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                    />
                    <input
                      type="email"
                      required
                      placeholder="Work email"
                      value={emailReport.email}
                      onChange={(e) => setEmailReport({ ...emailReport, email: e.target.value })}
                      className="px-3 py-2 rounded-lg border border-border-strong/40 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                    />
                    <input
                      placeholder="Company"
                      value={emailReport.company}
                      onChange={(e) => setEmailReport({ ...emailReport, company: e.target.value })}
                      className="px-3 py-2 rounded-lg border border-border-strong/40 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                    />
                  </div>
                  {emailError && (
                    <p className="text-xs text-danger">{emailError}</p>
                  )}
                  <button
                    type="submit"
                    disabled={emailStatus === 'sending'}
                    className="w-full inline-flex items-center justify-center gap-2 bg-sidebar-bg hover:bg-sidebar-bg/90 disabled:bg-sidebar-bg/60 text-white px-4 py-2.5 rounded-lg text-sm font-semibold transition-colors"
                  >
                    {emailStatus === 'sending' ? (
                      <><Loader2 className="h-4 w-4 animate-spin" /> Sending…</>
                    ) : (
                      <>Email me the report <ArrowRight className="h-4 w-4" /></>
                    )}
                  </button>
                </form>
              )}
            </div>

            <div className="flex flex-col sm:flex-row gap-3">
              <Link
                to="/signup"
                onClick={() => { trackCTAClick(CTA.START_FREE_TRIAL, 'roi-calculator', 'results'); trackConversionEvent('cta_click', '/roi-calculator', { cta: 'signup_roi' }); }}
                className="flex-1 flex items-center justify-center gap-2 bg-primary hover:bg-primary-hover text-white px-6 py-3 rounded-xl font-medium transition-colors"
              >
                Start Free Trial <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/book-demo"
                onClick={() => { trackCTAClick(CTA.BOOK_DEMO, 'roi-calculator', 'results'); }}
                className="flex-1 flex items-center justify-center gap-2 bg-surface-secondary hover:bg-border-strong/30 text-sidebar-bg px-6 py-3 rounded-xl font-medium transition-colors border border-border-strong/40"
              >
                Book a Demo
              </Link>
              <button
                onClick={() => { setStep(0); setEmailStatus('idle'); }}
                className="flex items-center justify-center gap-2 text-slate-600 hover:text-sidebar-bg px-6 py-3 rounded-xl font-medium transition-colors border border-slate-200"
              >
                Recalculate
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
