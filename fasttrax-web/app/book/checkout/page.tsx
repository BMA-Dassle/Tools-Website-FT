"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import BrandNav from "@/components/BrandNav";
import ContactForm from "@/app/book/race/components/ContactForm";
import type { ContactInfo } from "@/app/book/race/components/ContactForm";
import OrderSummary from "@/app/book/race/components/OrderSummary";
import type { BookingItem } from "@/app/book/race/components/OrderSummary";
import MiniCart from "@/components/booking/MiniCart";

/**
 * Shared checkout page — works for any bill (attractions, racing, or mixed).
 * Reads orderId from sessionStorage. Shows contact form, then OrderSummary
 * (same component as racing) for review & payment.
 */
export default function CheckoutPage() {
  const router = useRouter();
  const [orderId, setOrderId] = useState<string | null>(null);
  const [contact, setContact] = useState<ContactInfo | null>(null);
  const [step, setStep] = useState<"loading" | "contact" | "review" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    const stored = sessionStorage.getItem("attractionOrderId");
    if (!stored) {
      setStep("error");
      setErrorMsg("No booking found. Start by picking an activity.");
      return;
    }
    setOrderId(stored);
    setStep("contact");
  }, []);

  function handleContactSubmit(c: ContactInfo) {
    setContact(c);
    setStep("review");
  }

  function handleBack() {
    if (step === "review") {
      setStep("contact");
      return;
    }
    const returnPath = sessionStorage.getItem("checkoutReturnPath") || "/book";
    window.location.href = returnPath;
  }

  return (
    <div className="min-h-screen bg-[#000418]">
      <BrandNav />
      <MiniCart />

      <div className="max-w-3xl mx-auto px-4 pt-32 sm:pt-36 pb-16">

        {step === "loading" && (
          <div className="flex justify-center py-16">
            <div className="w-8 h-8 border-2 border-white/20 border-t-[#00E2E5] rounded-full animate-spin" />
          </div>
        )}

        {step === "error" && (
          <div className="text-center space-y-4 py-16">
            <p className="text-red-400">{errorMsg}</p>
            <a href="/book" className="text-[#00E2E5] underline text-sm">Browse experiences</a>
          </div>
        )}

        {step === "contact" && (
          <div className="max-w-lg mx-auto space-y-6">
            <div>
              <button onClick={handleBack} className="text-white/40 hover:text-white/70 text-sm mb-4 transition-colors">
                ← Back
              </button>
              <div className="text-center">
                <h1 className="text-3xl font-display text-white uppercase tracking-widest mb-2">Checkout</h1>
                <p className="text-white/40 text-sm">Enter your details to complete booking.</p>
              </div>
            </div>
            <ContactForm initial={contact} onSubmit={handleContactSubmit} onBack={handleBack} />
          </div>
        )}

        {step === "review" && orderId && contact && (
          <OrderSummary
            bookings={[]}
            date=""
            contact={contact}
            onBack={handleBack}
            billId={orderId}
            bills={[{ billId: orderId, racerName: contact.firstName + " " + contact.lastName, category: "adult" }]}
            confirmationPath="/book/confirmation"
          />
        )}
      </div>
    </div>
  );
}
