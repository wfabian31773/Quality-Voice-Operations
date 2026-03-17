import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ArrowLeft, Calculator, DollarSign, TrendingUp, Clock } from 'lucide-react';
import { trackCTAClick, trackConversionEvent } from '../lib/analytics';

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

  const results = useMemo(() => {
    const totalMinutesPerMonth = monthlyCallVolume * avgHandleTime;
    const totalHoursPerMonth = totalMinutesPerMonth / 60;
    const currentMonthlyCost = totalHoursPerMonth * agentHourlyCost;
    const qvoMonthlyCost = (totalMinutesPerMonth * QVO_COST_PER_MINUTE) + QVO_MONTHLY_BASE;
    const monthlySavings = Math.max(0, currentMonthlyCost - qvoMonthlyCost);
    const annualSavings = monthlySavings * 12;
    const annualROI = qvoMonthlyCost > 0 ? ((monthlySavings * 12) / (qvoMonthlyCost * 12)) * 100 : 0;
    const paybackDays = monthlySavings > 0 ? Math.ceil((qvoMonthlyCost / monthlySavings) * 30) : 0;

    return {
      currentMonthlyCost,
      qvoMonthlyCost,
      monthlySavings,
      annualSavings,
      annualROI,
      paybackDays,
      totalMinutesPerMonth,
    };
  }, [monthlyCallVolume, avgHandleTime, agentHourlyCost]);

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
  };

  const steps = [
    {
      title: 'Monthly Call Volume',
      description: 'How many calls does your business handle per month?',
      input: (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-500">Calls per month</span>
            <span className="text-2xl font-display font-bold text-harbor">{monthlyCallVolume.toLocaleString()}</span>
          </div>
          <input
            type="range"
            min={50}
            max={5000}
            step={50}
            value={monthlyCallVolume}
            onChange={(e) => setMonthlyCallVolume(Number(e.target.value))}
            className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-teal"
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
            <span className="text-2xl font-display font-bold text-harbor">{avgHandleTime} min</span>
          </div>
          <input
            type="range"
            min={1}
            max={15}
            step={0.5}
            value={avgHandleTime}
            onChange={(e) => setAvgHandleTime(Number(e.target.value))}
            className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-teal"
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
            <span className="text-2xl font-display font-bold text-harbor">${agentHourlyCost}/hr</span>
          </div>
          <input
            type="range"
            min={10}
            max={50}
            step={1}
            value={agentHourlyCost}
            onChange={(e) => setAgentHourlyCost(Number(e.target.value))}
            className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-teal"
          />
          <div className="flex justify-between text-xs text-slate-400">
            <span>$10/hr</span>
            <span>$50/hr</span>
          </div>
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
              <div className="w-8 h-8 rounded-lg bg-teal/10 flex items-center justify-center">
                <Calculator className="h-4 w-4 text-teal" />
              </div>
              <div className="flex gap-1.5">
                {steps.map((_, idx) => (
                  <div
                    key={idx}
                    className={`h-1.5 w-8 rounded-full transition-colors ${
                      idx <= step ? 'bg-teal' : 'bg-slate-200'
                    }`}
                  />
                ))}
              </div>
            </div>
            <h3 className="text-xl font-display font-bold text-harbor mt-6 mb-1">
              {steps[step].title}
            </h3>
            <p className="text-sm text-slate-500 mb-8">{steps[step].description}</p>
            {steps[step].input}
            <div className="flex justify-between mt-8">
              <button
                onClick={() => setStep(step - 1)}
                disabled={step === 0}
                className="flex items-center gap-1 text-sm text-slate-500 hover:text-harbor disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <ArrowLeft className="h-4 w-4" /> Back
              </button>
              <button
                onClick={() => setStep(step + 1)}
                className="flex items-center gap-2 bg-teal hover:bg-teal-hover text-white px-5 py-2.5 rounded-xl text-sm font-medium transition-colors"
              >
                {step === steps.length - 1 ? 'See My Results' : 'Next'} <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        ) : (
          <div className="p-8">
            <h3 className="text-xl font-display font-bold text-harbor mb-2">Your Projected Savings</h3>
            <p className="text-sm text-slate-500 mb-8">
              Based on {monthlyCallVolume.toLocaleString()} calls/month at {avgHandleTime} min each, paying ${agentHourlyCost}/hr
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
                  <span className="font-medium text-harbor">{formatCurrency(results.currentMonthlyCost)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-slate-600">QVO monthly cost</span>
                  <span className="font-medium text-teal">{formatCurrency(results.qvoMonthlyCost)}</span>
                </div>
                <div className="border-t border-slate-200 pt-3 flex justify-between text-sm font-semibold">
                  <span className="text-harbor">Annual savings</span>
                  <span className="text-emerald-600">{formatCurrency(results.annualSavings)}/year</span>
                </div>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row gap-3">
              <Link
                to="/signup"
                onClick={() => { trackCTAClick('Start Free Trial', 'roi-calculator', 'results'); trackConversionEvent('cta_click', '/roi-calculator', { cta: 'signup_roi' }); }}
                className="flex-1 flex items-center justify-center gap-2 bg-teal hover:bg-teal-hover text-white px-6 py-3 rounded-xl font-medium transition-colors"
              >
                Start Free Trial <ArrowRight className="h-4 w-4" />
              </Link>
              <button
                onClick={() => setStep(0)}
                className="flex items-center justify-center gap-2 text-slate-600 hover:text-harbor px-6 py-3 rounded-xl font-medium transition-colors border border-slate-200"
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
