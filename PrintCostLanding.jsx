/**
 * PrintCost — 3D baskı maliyet hesaplayıcı (tek dosya React bileşeni)
 *
 * Gereksinimler:
 *   npm i lucide-react
 *   Tailwind CSS (shadcn/ui projesiyle uyumlu)
 *
 * Kullanım:
 *   import PrintCostLanding from "./PrintCostLanding";
 *   <PrintCostLanding />
 */

"use client";

import { useMemo, useState } from "react";
import {
  ArrowRight,
  Boxes,
  Calculator,
  Check,
  Clock,
  Gauge,
  Info,
  Layers,
  Menu,
  Palette,
  Percent,
  Printer,
  RotateCcw,
  ShieldCheck,
  TrendingUp,
  Zap,
  X,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Yardımcılar                                                        */
/* ------------------------------------------------------------------ */

const cn = (...parts) => parts.filter(Boolean).join(" ");

const tryFormat = (value, digits = 2) =>
  new Intl.NumberFormat("tr-TR", {
    style: "currency",
    currency: "TRY",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Number.isFinite(value) ? value : 0);

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const num = (value) => (Number.isFinite(value) ? Math.max(0, value) : 0);

/* ------------------------------------------------------------------ */
/*  shadcn tarzı temel bileşenler                                      */
/* ------------------------------------------------------------------ */

function Button({ variant = "default", className, children, ...props }) {
  const styles = {
    default:
      "bg-[#17181A] text-[#FAFAF8] hover:bg-[#2A2C30] active:bg-[#0F1011]",
    accent:
      "bg-[#B4441C] text-white hover:bg-[#9C3915] active:bg-[#853010]",
    outline:
      "border border-[#DCD9D1] bg-transparent text-[#26282B] hover:border-[#B4441C]/45 hover:bg-[#B4441C]/[0.04]",
    ghost: "text-[#4B4E54] hover:bg-[#17181A]/[0.05]",
  };

  return (
    <button
      className={cn(
        "inline-flex h-11 items-center justify-center gap-2 rounded-lg px-5 text-sm font-medium",
        "transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2",
        "focus-visible:ring-[#B4441C] focus-visible:ring-offset-2 focus-visible:ring-offset-[#F5F4F0]",
        "disabled:pointer-events-none disabled:opacity-45",
        styles[variant],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

function Field({ id, label, hint, suffix, value, onChange, min = 0, step = 1 }) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-[13px] font-medium text-[#3C3F44]">
          {label}
        </label>
        {hint ? (
          <span className="text-[11px] text-[#8B8E94]">{hint}</span>
        ) : null}
      </div>
      <div className="flex h-11 items-center rounded-lg border border-[#DCD9D1] bg-white transition-colors focus-within:border-[#B4441C] focus-within:ring-2 focus-within:ring-[#B4441C]/15">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          min={min}
          step={step}
          value={value}
          onChange={(event) =>
            onChange(Math.max(min, Number(event.target.value) || 0))
          }
          className="h-full w-full min-w-0 rounded-lg bg-transparent px-3 text-[14px] tabular-nums text-[#17181A] outline-none"
        />
        {suffix ? (
          <span className="shrink-0 pr-3 text-[12px] text-[#8B8E94]">
            {suffix}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function RangeField({ id, label, value, min, max, step, onChange, suffix }) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-[13px] font-medium text-[#3C3F44]">
          {label}
        </label>
        <output
          htmlFor={id}
          className="rounded-md bg-[#EFEDE7] px-2 py-0.5 text-[12px] font-semibold tabular-nums text-[#26282B]"
        >
          {value} {suffix}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={clamp(value, min, max)}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-[#E1DED6] accent-[#B4441C] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#B4441C] focus-visible:ring-offset-2"
      />
    </div>
  );
}

function Panel({ title, icon: Icon, children, aside }) {
  return (
    <section className="rounded-xl border border-[#E3E0D8] bg-white p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-[13px] font-semibold uppercase tracking-[0.08em] text-[#6A6D73]">
          <Icon className="h-4 w-4 text-[#B4441C]" strokeWidth={1.75} />
          {title}
        </h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Sabitler                                                           */
/* ------------------------------------------------------------------ */

const PRESETS = [
  {
    key: "keychain",
    label: "Anahtarlık",
    values: { grams: 12, qty: 50, hours: 5, waste: 10, margin: 90 },
  },
  {
    key: "figure",
    label: "Figür",
    values: { grams: 85, qty: 8, hours: 22, waste: 14, margin: 55 },
  },
  {
    key: "vase",
    label: "Vazo",
    values: { grams: 240, qty: 3, hours: 30, waste: 18, margin: 45 },
  },
];

const STOCK = [
  { name: "Pembe", kg: 1.2, max: 1.6, low: false },
  { name: "Siyah", kg: 0.6, max: 1.6, low: true },
  { name: "Beyaz", kg: 0.25, max: 1.6, low: true },
];

const INITIAL = {
  grams: 42,
  qty: 20,
  hours: 6.5,
  filamentPrice: 550,
  waste: 12,
  printerPower: 120,
  energyPrice: 4.2,
  printerPrice: 12500,
  lifeHours: 8000,
  wear: 1.5,
  labor: 0,
  margin: 60,
};

/* ------------------------------------------------------------------ */
/*  Bileşen                                                            */
/* ------------------------------------------------------------------ */

export default function PrintCostLanding() {
  const [form, setForm] = useState(INITIAL);
  const [preset, setPreset] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const set = (key) => (value) => {
    setPreset(null);
    setForm((current) => ({ ...current, [key]: value }));
  };

  const applyPreset = (item) => {
    setPreset(item.key);
    setForm((current) => ({ ...current, ...item.values }));
  };

  const reset = () => {
    setPreset(null);
    setForm(INITIAL);
  };

  /* ------------------------ hesaplama ------------------------ */
  const result = useMemo(() => {
    const grams = num(form.grams);
    const qty = Math.max(1, num(form.qty));
    const hours = num(form.hours);
    const waste = num(form.waste);

    const totalGrams = grams * qty;
    const filament =
      (totalGrams * (1 + waste / 100) * num(form.filamentPrice)) / 1000;
    const energy =
      (num(form.printerPower) / 1000) * hours * num(form.energyPrice);
    const depreciation =
      (num(form.printerPrice) / Math.max(1, num(form.lifeHours))) * hours;
    const wear = num(form.wear) * hours;
    const labor = num(form.labor);

    const total = filament + energy + depreciation + wear + labor;
    const perUnit = total / qty;
    const suggested = perUnit * (1 + num(form.margin) / 100);
    const profit = suggested * qty - total;

    const parts = [
      { key: "filament", label: "Filament", value: filament },
      { key: "energy", label: "Enerji", value: energy },
      { key: "depreciation", label: "Amortisman", value: depreciation },
      { key: "wear", label: "Aşınma", value: wear },
      { key: "labor", label: "İşçilik", value: labor },
    ].filter((part) => part.value > 0);

    return {
      filament,
      energy,
      depreciation,
      totalGrams,
      wasteGrams: totalGrams * (waste / 100),
      total,
      perUnit,
      suggested,
      profit,
      parts: parts.map((part) => ({
        ...part,
        share: total > 0 ? (part.value / total) * 100 : 0,
      })),
    };
  }, [form]);

  const scrollToCalculator = () =>
    document.getElementById("hesaplayici")?.scrollIntoView({ behavior: "smooth" });

  return (
    <div className="min-h-screen bg-[#F5F4F0] text-[#17181A] antialiased selection:bg-[#B4441C]/20">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter+Tight:wght@400;500;600;700&display=swap');
        .pc-root { font-family: 'Inter Tight', ui-sans-serif, system-ui, sans-serif; }
        .pc-display { font-family: 'Instrument Serif', Georgia, serif; font-weight: 400; letter-spacing: -0.02em; }
        .pc-root :where(button, a, input):focus-visible { scroll-margin-top: 96px; }
        @media (prefers-reduced-motion: reduce) {
          .pc-root *, .pc-root *::before, .pc-root *::after {
            animation-duration: 0.01ms !important;
            transition-duration: 0.01ms !important;
            scroll-behavior: auto !important;
          }
        }
      `}</style>

      <div className="pc-root">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-[#17181A] focus:px-4 focus:py-2 focus:text-sm focus:text-white"
        >
          İçeriğe geç
        </a>

        {/* ---------------------------------------------------- header */}
        <header className="sticky top-0 z-50 border-b border-[#E3E0D8] bg-[#F5F4F0]">
          <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-5">
            <a href="#main" className="flex items-center gap-2.5">
              <span className="grid h-8 w-8 place-items-center rounded-lg border border-[#DCD9D1] bg-white">
                <Printer className="h-4 w-4 text-[#B4441C]" strokeWidth={1.75} />
              </span>
              <span className="text-[15px] font-semibold tracking-tight">
                PrintCost
              </span>
            </a>

            <nav aria-label="Ana menü" className="hidden items-center gap-1 md:flex">
              {[
                ["Özellikler", "#ozellikler"],
                ["Hesaplayıcı", "#hesaplayici"],
                ["Nasıl çalışır", "#nasil-calisir"],
              ].map(([label, href]) => (
                <a
                  key={href}
                  href={href}
                  className="rounded-md px-3 py-2 text-[13.5px] text-[#5A5D63] transition-colors hover:bg-[#17181A]/[0.04] hover:text-[#17181A] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#B4441C]"
                >
                  {label}
                </a>
              ))}
            </nav>

            <div className="hidden items-center gap-2 md:flex">
              <Button variant="ghost" onClick={scrollToCalculator}>
                Hızlı tahmin
              </Button>
              <Button variant="accent" onClick={scrollToCalculator}>
                Hesapla
                <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
              </Button>
            </div>

            <button
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              aria-expanded={menuOpen}
              aria-controls="mobil-menu"
              aria-label={menuOpen ? "Menüyü kapat" : "Menüyü aç"}
              className="grid h-11 w-11 place-items-center rounded-lg border border-[#DCD9D1] bg-white text-[#26282B] transition-colors hover:border-[#B4441C]/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#B4441C] md:hidden"
            >
              {menuOpen ? (
                <X className="h-5 w-5" strokeWidth={1.75} />
              ) : (
                <Menu className="h-5 w-5" strokeWidth={1.75} />
              )}
            </button>
          </div>

          {menuOpen ? (
            <div
              id="mobil-menu"
              className="border-t border-[#E3E0D8] bg-[#F5F4F0] px-5 py-4 md:hidden"
            >
              <nav aria-label="Mobil menü" className="flex flex-col gap-1">
                {[
                  ["Özellikler", "#ozellikler"],
                  ["Hesaplayıcı", "#hesaplayici"],
                  ["Nasıl çalışır", "#nasil-calisir"],
                ].map(([label, href]) => (
                  <a
                    key={href}
                    href={href}
                    onClick={() => setMenuOpen(false)}
                    className="rounded-md px-3 py-2.5 text-sm text-[#3C3F44] hover:bg-[#17181A]/[0.04]"
                  >
                    {label}
                  </a>
                ))}
              </nav>
              <Button
                variant="accent"
                className="mt-3 w-full"
                onClick={() => {
                  setMenuOpen(false);
                  scrollToCalculator();
                }}
              >
                Hesapla
                <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
              </Button>
            </div>
          ) : null}
        </header>

        <main id="main">
          {/* -------------------------------------------------- hero */}
          <section className="relative overflow-hidden border-b border-[#E3E0D8]">
            <div className="mx-auto grid max-w-6xl gap-12 px-5 py-16 lg:grid-cols-[1.15fr_0.85fr] lg:items-center lg:py-24">
              <div>
                <p className="inline-flex items-center gap-2 rounded-full border border-[#DCD9D1] bg-white px-3 py-1 text-[11px] font-medium uppercase tracking-[0.12em] text-[#6A6D73]">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#B4441C]" />
                  Maliyet, tahmin değil
                </p>

                <h1 className="pc-display mt-5 text-[clamp(2.6rem,6vw,4.6rem)] leading-[1.02] text-[#17181A] [text-wrap:balance]">
                  Baskının gerçek maliyetini{" "}
                  <em className="not-italic text-[#B4441C]">tahmin etmeyi</em>{" "}
                  bırak.
                </h1>

                <p className="mt-5 max-w-xl text-[15.5px] leading-relaxed text-[#5A5D63]">
                  Filament, fire, enerji, amortisman ve işçilik tek panelde.
                  Gramı ve adedi gir; birim maliyeti ve satış fiyatını saniyeler
                  içinde gör.
                </p>

                <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                  <Button variant="accent" onClick={scrollToCalculator}>
                    Hesaplamaya başla
                    <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
                  </Button>
                  <Button variant="outline" onClick={scrollToCalculator}>
                    <Calculator className="h-4 w-4" strokeWidth={1.75} />
                    Örnek değerleri dene
                  </Button>
                </div>

                <dl className="mt-10 grid max-w-lg grid-cols-3 gap-4 border-t border-[#E3E0D8] pt-6">
                  {[
                    ["3 sn", "Canlı sonuç"],
                    ["5 kalem", "Maliyet kırılımı"],
                    ["%0", "Sunucuya veri"],
                  ].map(([value, label]) => (
                    <div key={label}>
                      <dt className="sr-only">{label}</dt>
                      <dd>
                        <span className="block text-lg font-semibold tracking-tight">
                          {value}
                        </span>
                        <span className="mt-0.5 block text-[12px] text-[#7C7F85]">
                          {label}
                        </span>
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>

              {/* canlı özet kartı */}
              <aside
                aria-label="Canlı maliyet özeti"
                className="relative rounded-2xl border border-[#E3E0D8] bg-white p-6 shadow-[0_1px_2px_rgba(23,24,26,0.04)]"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8B8E94]">
                    Canlı özet
                  </span>
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-800">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-600" />
                    güncel
                  </span>
                </div>

                <p className="mt-6 text-[12px] text-[#7C7F85]">Birim maliyet</p>
                <p className="pc-display mt-1 text-5xl tabular-nums text-[#17181A]">
                  {tryFormat(result.perUnit, 2)}
                </p>

                <div className="mt-6 space-y-3 border-t border-[#EFEDE7] pt-5">
                  {[
                    ["Parti toplamı", tryFormat(result.total, 2)],
                    [
                      "Toplam filament",
                      `${result.totalGrams.toLocaleString("tr-TR")} g`,
                    ],
                    ["Önerilen satış", tryFormat(result.suggested, 2)],
                  ].map(([label, value]) => (
                    <div
                      key={label}
                      className="flex items-baseline justify-between gap-3 text-[13px]"
                    >
                      <span className="text-[#6A6D73]">{label}</span>
                      <span className="font-semibold tabular-nums text-[#26282B]">
                        {value}
                      </span>
                    </div>
                  ))}
                </div>

                <div className="mt-5 rounded-lg border border-[#EFEDE7] bg-[#FAF9F6] px-4 py-3">
                  <p className="flex items-center gap-2 text-[12px] leading-relaxed text-[#6A6D73]">
                    <ShieldCheck className="h-4 w-4 shrink-0 text-[#B4441C]" strokeWidth={1.75} />
                    Tüm hesaplama tarayıcında; hiçbir veri dışarı gönderilmez.
                  </p>
                </div>
              </aside>
            </div>
          </section>

          {/* ------------------------------------------- bento grid */}
          <section
            id="ozellikler"
            aria-labelledby="ozellikler-baslik"
            className="mx-auto max-w-6xl scroll-mt-24 px-5 py-16 lg:py-20"
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#B4441C]">
                  01 — Neler var
                </p>
                <h2
                  id="ozellikler-baslik"
                  className="pc-display mt-2 text-4xl text-[#17181A] sm:text-5xl"
                >
                  Tek ekran, tam kontrol
                </h2>
              </div>
              <p className="max-w-sm text-[14px] leading-relaxed text-[#6A6D73]">
                Hesap tablosu yok, formül karmaşası yok. Beş maliyet kalemi,
                tek bir net sonuç.
              </p>
            </div>

            <div className="mt-10 grid grid-cols-1 gap-4 md:grid-cols-6">
              {/* renk stoğu */}
              <article className="group flex flex-col justify-between rounded-xl border border-[#E3E0D8] bg-white p-6 transition-colors hover:border-[#C9C5BB] md:col-span-3">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-[15px] font-semibold tracking-tight">
                      Renk bazlı stok
                    </h3>
                    <p className="mt-1.5 max-w-xs text-[13.5px] leading-relaxed text-[#6A6D73]">
                      Her renkten ne kadar kaldığını gör; hangi işin önce
                      tükeneceğini bil.
                    </p>
                  </div>
                  <Palette className="h-5 w-5 shrink-0 text-[#B4441C]" strokeWidth={1.5} />
                </div>

                <ul className="mt-7 space-y-3.5">
                  {STOCK.map((item) => (
                    <li key={item.name}>
                      <div className="flex items-center justify-between gap-3 text-[12.5px]">
                        <span className="flex items-center gap-2 font-medium text-[#3C3F44]">
                          <span
                            className={cn(
                              "h-2 w-2 rounded-full",
                              item.low ? "bg-[#B4441C]" : "bg-[#26282B]",
                            )}
                          />
                          {item.name}
                        </span>
                        <span className="tabular-nums text-[#6A6D73]">
                          {item.kg.toFixed(2)} kg
                        </span>
                      </div>
                      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[#EFEDE7]">
                        <div
                          className={cn(
                            "h-full rounded-full transition-[width] duration-300",
                            item.low ? "bg-[#B4441C]" : "bg-[#4B4E54]",
                          )}
                          style={{ width: `${(item.kg / item.max) * 100}%` }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              </article>

              {/* fire */}
              <article className="group flex flex-col justify-between rounded-xl border border-[#E3E0D8] bg-white p-6 transition-colors hover:border-[#C9C5BB] md:col-span-3">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-[15px] font-semibold tracking-tight">
                      Fire payı hesaba dahil
                    </h3>
                    <p className="mt-1.5 max-w-xs text-[13.5px] leading-relaxed text-[#6A6D73]">
                      Destek, purge ve başarısız baskı payı gerçek tüketime
                      eklenir — sürpriz maliyet çıkmaz.
                    </p>
                  </div>
                  <Percent className="h-5 w-5 shrink-0 text-[#B4441C]" strokeWidth={1.5} />
                </div>

                <div className="mt-7 flex items-end justify-between gap-6">
                  <div>
                    <p className="pc-display text-5xl tabular-nums text-[#17181A]">
                      %{form.waste}
                    </p>
                    <p className="mt-1 text-[12px] text-[#7C7F85]">
                      + {Math.round(result.wasteGrams).toLocaleString("tr-TR")} g
                      ek tüketim
                    </p>
                  </div>
                  <div className="flex h-16 items-end gap-1.5" aria-hidden="true">
                    {[42, 58, 47, 70, 63, form.waste * 4].map((height, index) => (
                      <span
                        key={index}
                        className="w-2 rounded-sm bg-[#EFEDE7] transition-colors group-hover:bg-[#E4E0D6]"
                        style={{ height: `${clamp(height, 18, 100)}%` }}
                      />
                    ))}
                  </div>
                </div>
              </article>

              {/* enerji */}
              <article className="rounded-xl border border-[#E3E0D8] bg-white p-5 transition-colors hover:border-[#C9C5BB] md:col-span-2">
                <Zap className="h-5 w-5 text-[#B4441C]" strokeWidth={1.5} />
                <h3 className="mt-4 text-[14px] font-semibold tracking-tight">
                  Enerji ve amortisman
                </h3>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-[#6A6D73]">
                  Watt, saat ve makine ömrü üzerinden gerçek makine maliyeti.
                </p>
                <p className="mt-4 text-[13px] font-semibold tabular-nums text-[#26282B]">
                  {tryFormat(result.energy + result.depreciation, 2)}
                  <span className="ml-1.5 font-normal text-[#8B8E94]">
                    / parti
                  </span>
                </p>
              </article>

              {/* kâr */}
              <article className="rounded-xl border border-[#E3E0D8] bg-white p-5 transition-colors hover:border-[#C9C5BB] md:col-span-2">
                <TrendingUp className="h-5 w-5 text-[#B4441C]" strokeWidth={1.5} />
                <h3 className="mt-4 text-[14px] font-semibold tracking-tight">
                  Net kâr
                </h3>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-[#6A6D73]">
                  Hedef marjı seç; parti kârını satış fiyatıyla birlikte gör.
                </p>
                <p className="mt-4 text-[13px] font-semibold tabular-nums text-[#26282B]">
                  {tryFormat(result.profit, 2)}
                  <span className="ml-1.5 font-normal text-[#8B8E94]">
                    / parti
                  </span>
                </p>
              </article>

              {/* panel */}
              <article className="rounded-xl border border-[#E3E0D8] bg-[#17181A] p-5 text-[#FAFAF8] md:col-span-2">
                <Gauge className="h-5 w-5 text-[#D98A68]" strokeWidth={1.5} />
                <h3 className="mt-4 text-[14px] font-semibold tracking-tight">
                  Tek panelde
                </h3>
                <ul className="mt-3 space-y-2 text-[12.5px] text-[#B9BABD]">
                  {["Parametre kaydı", "Anlık hesap", "Mobil uyumlu"].map(
                    (item) => (
                      <li key={item} className="flex items-center gap-2">
                        <Check className="h-3.5 w-3.5 text-[#D98A68]" strokeWidth={2} />
                        {item}
                      </li>
                    ),
                  )}
                </ul>
              </article>
            </div>
          </section>

          {/* -------------------------------------------- hesaplayıcı */}
          <section
            id="hesaplayici"
            aria-labelledby="hesaplayici-baslik"
            className="border-y border-[#E3E0D8] bg-[#F0EEE8]"
          >
            <div className="mx-auto max-w-6xl scroll-mt-24 px-5 py-16 lg:py-20">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#B4441C]">
                    02 — Hesaplayıcı
                  </p>
                  <h2
                    id="hesaplayici-baslik"
                    className="pc-display mt-2 text-4xl text-[#17181A] sm:text-5xl"
                  >
                    Değerleri gir, sonucu gör
                  </h2>
                </div>

                <div
                  className="flex flex-wrap gap-2"
                  role="group"
                  aria-label="Hazır örnekler"
                >
                  {PRESETS.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => applyPreset(item)}
                      aria-pressed={preset === item.key}
                      className={cn(
                        "h-9 rounded-full border px-3.5 text-[12.5px] font-medium transition-colors",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#B4441C] focus-visible:ring-offset-2",
                        preset === item.key
                          ? "border-[#17181A] bg-[#17181A] text-white"
                          : "border-[#D6D2C9] bg-white text-[#4B4E54] hover:border-[#B4441C]/45",
                      )}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mt-8 grid grid-cols-1 gap-5 lg:grid-cols-[1.25fr_0.85fr] lg:items-start">
                {/* girişler */}
                <div className="space-y-4">
                  <Panel
                    title="Filament"
                    icon={Layers}
                    aside={
                      <span className="text-[11.5px] tabular-nums text-[#8B8E94]">
                        {result.totalGrams.toLocaleString("tr-TR")} g toplam
                      </span>
                    }
                  >
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field
                        id="filament-price"
                        label="Filament fiyatı"
                        hint="TL / kg"
                        suffix="₺"
                        value={form.filamentPrice}
                        min={0}
                        step={10}
                        onChange={set("filamentPrice")}
                      />
                      <Field
                        id="unit-grams"
                        label="Birim ağırlık"
                        hint="gram / adet"
                        suffix="g"
                        value={form.grams}
                        min={0}
                        step={1}
                        onChange={set("grams")}
                      />
                    </div>
                    <div className="mt-5">
                      <RangeField
                        id="waste"
                        label="Fire payı"
                        value={form.waste}
                        min={0}
                        max={40}
                        step={1}
                        suffix="%"
                        onChange={set("waste")}
                      />
                    </div>
                  </Panel>

                  <Panel title="Baskı" icon={Clock}>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <RangeField
                        id="hours"
                        label="Toplam süre"
                        value={form.hours}
                        min={0.5}
                        max={80}
                        step={0.5}
                        suffix="sa"
                        onChange={set("hours")}
                      />
                      <RangeField
                        id="qty"
                        label="Parti adedi"
                        value={form.qty}
                        min={1}
                        max={120}
                        step={1}
                        suffix="adet"
                        onChange={set("qty")}
                      />
                      <Field
                        id="power"
                        label="Ortalama güç"
                        hint="Watt"
                        suffix="W"
                        value={form.printerPower}
                        min={0}
                        step={5}
                        onChange={set("printerPower")}
                      />
                      <Field
                        id="energy-price"
                        label="Elektrik"
                        hint="TL / kWh"
                        suffix="₺"
                        value={form.energyPrice}
                        min={0}
                        step={0.1}
                        onChange={set("energyPrice")}
                      />
                    </div>
                  </Panel>

                  <Panel title="Makine ve işçilik" icon={Printer}>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field
                        id="printer-price"
                        label="Makine bedeli"
                        hint="TL"
                        suffix="₺"
                        value={form.printerPrice}
                        min={0}
                        step={100}
                        onChange={set("printerPrice")}
                      />
                      <Field
                        id="life-hours"
                        label="Tahmini ömür"
                        hint="saat"
                        suffix="sa"
                        value={form.lifeHours}
                        min={100}
                        step={100}
                        onChange={set("lifeHours")}
                      />
                      <Field
                        id="wear"
                        label="Aşınma payı"
                        hint="TL / saat"
                        suffix="₺"
                        value={form.wear}
                        min={0}
                        step={0.1}
                        onChange={set("wear")}
                      />
                      <Field
                        id="labor"
                        label="İşçilik"
                        hint="TL / parti"
                        suffix="₺"
                        value={form.labor}
                        min={0}
                        step={5}
                        onChange={set("labor")}
                      />
                    </div>
                  </Panel>
                </div>

                {/* sonuç */}
                <aside
                  aria-labelledby="sonuc-baslik"
                  className="rounded-xl border border-[#26282B] bg-[#17181A] p-6 text-[#FAFAF8] lg:sticky lg:top-24"
                >
                  <div className="flex items-center justify-between gap-3">
                    <h3
                      id="sonuc-baslik"
                      className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#9EA1A6]"
                    >
                      Maliyet özeti
                    </h3>
                    <button
                      type="button"
                      onClick={reset}
                      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-white/15 px-2.5 text-[11.5px] text-[#C9CACD] transition-colors hover:border-white/30 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D98A68]"
                    >
                      <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} />
                      Sıfırla
                    </button>
                  </div>

                  <div aria-live="polite" aria-atomic="true">
                    <p className="mt-6 text-[12px] text-[#9EA1A6]">Birim maliyet</p>
                    <p className="pc-display mt-1 text-[3.4rem] leading-none tabular-nums">
                      {tryFormat(result.perUnit, 2)}
                    </p>
                    <p className="mt-2 text-[12.5px] text-[#9EA1A6]">
                      {form.qty} adet · {result.totalGrams.toLocaleString("tr-TR")} g
                      · %{form.waste} fire
                    </p>
                  </div>

                  <dl className="mt-6 space-y-3 border-t border-white/10 pt-5 text-[13px]">
                    {[
                      ["Önerilen satış", tryFormat(result.suggested, 2)],
                      ["Parti kârı", tryFormat(result.profit, 2)],
                      ["Parti maliyeti", tryFormat(result.total, 2)],
                    ].map(([label, value], index) => (
                      <div
                        key={label}
                        className="flex items-baseline justify-between gap-3"
                      >
                        <dt className="text-[#9EA1A6]">{label}</dt>
                        <dd
                          className={cn(
                            "font-semibold tabular-nums",
                            index === 1 ? "text-[#E9A184]" : "text-white",
                          )}
                        >
                          {value}
                        </dd>
                      </div>
                    ))}
                  </dl>

                  <div className="mt-6 border-t border-white/10 pt-5">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#9EA1A6]">
                        Kırılım
                      </p>
                      <p className="text-[11px] text-[#6E7176]">
                        hedef marj %{form.margin}
                      </p>
                    </div>

                    <ul className="mt-3 space-y-2.5">
                      {result.parts.map((part) => (
                        <li key={part.key}>
                          <div className="flex items-baseline justify-between gap-3 text-[12px]">
                            <span className="text-[#C9CACD]">{part.label}</span>
                            <span className="tabular-nums text-[#9EA1A6]">
                              {tryFormat(part.value, 2)}
                            </span>
                          </div>
                          <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/10">
                            <div
                              className="h-full rounded-full bg-[#D98A68] transition-[width] duration-300"
                              style={{ width: `${part.share}%` }}
                            />
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className="mt-6">
                    <RangeField
                      id="margin"
                      label="Hedef kâr marjı"
                      value={form.margin}
                      min={0}
                      max={200}
                      step={5}
                      suffix="%"
                      onChange={set("margin")}
                    />
                  </div>

                  <Button
                    variant="accent"
                    className="mt-5 w-full bg-[#B4441C] hover:bg-[#9C3915]"
                    onClick={scrollToCalculator}
                  >
                    Sonucu doğrula
                    <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
                  </Button>

                  <p className="mt-3 flex items-start gap-2 text-[11.5px] leading-relaxed text-[#6E7176]">
                    <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
                    Sonuçlar tahminidir; fiyatlandırmadan önce gerçek tüketimle
                    karşılaştır.
                  </p>
                </aside>
              </div>
            </div>
          </section>

          {/* ---------------------------------------- nasıl çalışır */}
          <section
            id="nasil-calisir"
            aria-labelledby="nasil-baslik"
            className="mx-auto max-w-6xl scroll-mt-24 px-5 py-16 lg:py-20"
          >
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#B4441C]">
              03 — Süreç
            </p>
            <h2
              id="nasil-baslik"
              className="pc-display mt-2 max-w-2xl text-4xl text-[#17181A] sm:text-5xl"
            >
              Üç adımda fiyat kararı
            </h2>

            <ol className="mt-10 grid gap-4 md:grid-cols-3">
              {[
                {
                  icon: Boxes,
                  title: "Tüketimi gir",
                  text: "Birim gram, adet ve fire payı. Renk dağılımı toplamı otomatik hesaplanır.",
                },
                {
                  icon: Zap,
                  title: "Makineyi ekle",
                  text: "Süre, güç, elektrik fiyatı ve amortisman; gizli maliyet kalmaz.",
                },
                {
                  icon: TrendingUp,
                  title: "Fiyatı belirle",
                  text: "Hedef marjı kaydır, birim ve parti kârını anında gör.",
                },
              ].map((step, index) => (
                <li
                  key={step.title}
                  className="rounded-xl border border-[#E3E0D8] bg-white p-6 transition-colors hover:border-[#C9C5BB]"
                >
                  <div className="flex items-center justify-between gap-3">
                    <step.icon className="h-5 w-5 text-[#B4441C]" strokeWidth={1.5} />
                    <span className="text-[11px] font-semibold tabular-nums text-[#B0B2B6]">
                      0{index + 1}
                    </span>
                  </div>
                  <h3 className="mt-4 text-[15px] font-semibold tracking-tight">
                    {step.title}
                  </h3>
                  <p className="mt-2 text-[13.5px] leading-relaxed text-[#6A6D73]">
                    {step.text}
                  </p>
                </li>
              ))}
            </ol>
          </section>
        </main>

        {/* -------------------------------------------------- footer */}
        <footer className="border-t border-[#E3E0D8] bg-[#F5F4F0]">
          <div className="mx-auto max-w-6xl px-5 py-12">
            <div className="flex flex-col gap-10 md:flex-row md:items-start md:justify-between">
              <div className="max-w-xs">
                <div className="flex items-center gap-2.5">
                  <span className="grid h-8 w-8 place-items-center rounded-lg border border-[#DCD9D1] bg-white">
                    <Printer className="h-4 w-4 text-[#B4441C]" strokeWidth={1.75} />
                  </span>
                  <span className="text-[15px] font-semibold tracking-tight">
                    PrintCost
                  </span>
                </div>
                <p className="mt-3 text-[13px] leading-relaxed text-[#6A6D73]">
                  3D baskı atölyeleri için sade, dürüst maliyet hesabı.
                  Tarayıcıda çalışır, veriyi dışarı göndermez.
                </p>
              </div>

              <nav aria-label="Alt menü" className="grid grid-cols-2 gap-x-12 gap-y-2 text-[13px]">
                {[
                  ["Özellikler", "#ozellikler"],
                  ["Hesaplayıcı", "#hesaplayici"],
                  ["Nasıl çalışır", "#nasil-calisir"],
                  ["Başa dön", "#main"],
                ].map(([label, href]) => (
                  <a
                    key={href}
                    href={href}
                    className="rounded text-[#5A5D63] transition-colors hover:text-[#B4441C] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#B4441C]"
                  >
                    {label}
                  </a>
                ))}
              </nav>
            </div>

            <div className="mt-10 flex flex-col gap-3 border-t border-[#E3E0D8] pt-6 text-[12px] text-[#8B8E94] sm:flex-row sm:items-center sm:justify-between">
              <p>© {new Date().getFullYear()} PrintCost. Tüm hakları saklıdır.</p>
              <p className="flex items-center gap-1.5">
                <Layers className="h-3.5 w-3.5" strokeWidth={1.75} />
                Filament · enerji · amortisman · fire
              </p>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
