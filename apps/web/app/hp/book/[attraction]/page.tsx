"use client";

import HeadPinzNav from "@/components/headpinz/Nav";
import { AttractionBookingCore } from "@/app/book/[attraction]/page";

export default function HPAttractionBookingPage() {
  return <AttractionBookingCore navComponent={<HeadPinzNav />} />;
}
