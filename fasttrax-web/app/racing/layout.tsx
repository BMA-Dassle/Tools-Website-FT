import type { Metadata } from "next";
import { FAQJsonLd } from "@/components/seo/JsonLd";

export const metadata: Metadata = {
  title: "Indoor Go-Kart Racing & Qualifications – FastTrax Fort Myers",
  description:
    "Race high-performance EcoVolt GT electric karts on Florida's largest indoor multi-level track. Adult, Junior & Mini karts ages 4+. Starter to Pro qualification system. 63,000 sq ft in Fort Myers. Better than outdoor go-karts — rain or shine. Book your heat now.",
  keywords: [
    "indoor go kart racing Fort Myers",
    "go karts Fort Myers",
    "go karts near me",
    "electric go karts Florida",
    "indoor karting near me",
    "FastTrax racing",
    "go kart track Fort Myers",
    "things to do Fort Myers",
    "things to do in Fort Myers today",
    "Topgolf alternative Fort Myers",
    "Dave and Busters alternative Fort Myers",
    "Gator Mikes alternative",
    "indoor racing Florida",
    "multi level go kart track",
    "kids go karts Fort Myers",
    "junior go karts",
    "mini karts for kids",
    "go kart birthday party Fort Myers",
    "best go karts SWFL",
    "electric kart racing Fort Myers",
    "go kart qualification times",
    "fastest indoor go karts Florida",
    "family fun Fort Myers",
    "date night Fort Myers",
    "rainy day activities Fort Myers",
  ],
  openGraph: {
    title: "Indoor Go-Kart Racing – FastTrax Fort Myers, FL",
    description:
      "Florida's largest indoor multi-level electric kart track. Adult, Junior & Mini karts with Starter-to-Pro qualification system. 63,000 sq ft of racing action.",
    type: "website",
    url: "https://fasttraxent.com/racing",
  },
  alternates: {
    canonical: "https://fasttraxent.com/racing",
  },
};

const racingFaqs = [
  {
    question: "How much does go-kart racing cost at FastTrax?",
    answer:
      "Adult kart racing starts at $20.99 per heat (Mon-Thu) and $26.99 (Fri-Sun). Junior karts are $15.99-$19.99. Mini karts for ages 4-6 are $9.99-$14.99. A one-time $4.99 Racing License (valid for one year) is required for all racers.",
  },
  {
    question: "What age do you have to be to race at FastTrax?",
    answer:
      "FastTrax has karts for racers as young as 4 years old. Mini Karts are for ages 4-6. Junior Karts are for ages 7-13 (49\" to 70\" tall). Adult Karts are for ages 13+ (must be at least 59\" tall).",
  },
  {
    question: "How fast do the go-karts go at FastTrax?",
    answer:
      "FastTrax uses EcoVolt GT electric karts with 10.5 kW brushless motors that deliver instant acceleration. Speeds vary by tier — Starter karts are speed-controlled for safety, while Intermediate and Pro karts are progressively faster. Pro karts are the fastest available.",
  },
  {
    question: "Do I need a reservation to race at FastTrax?",
    answer:
      "Yes, races must be booked through the FastTrax Racing App or website. Book the day before to guarantee your heat. Walk-ins are accepted when availability allows, but booking in advance is strongly recommended.",
  },
  {
    question: "What is Mega Track Tuesday at FastTrax?",
    answer:
      "Every Tuesday, FastTrax pulls the barriers between the Blue and Red tracks to create Florida's largest indoor racing circuit — the 2,108 ft Mega Track. All kart classes race the Mega Track at the same $20.99 rate. Note: first-time Junior racers cannot race the Mega Track.",
  },
  {
    question: "How do I qualify for faster karts at FastTrax?",
    answer:
      "All racers start in Starter tier. To unlock Adult Intermediate, you need a lap time of 41s on the Blue Track or 46s on the Red Track. For Adult Pro, you need 32.5s (Blue) or 37s (Red) in Intermediate. Junior Intermediate requires a 1:15 lap in Junior Starter, and Junior Pro requires a 45s lap in Junior Intermediate. You cannot skip levels.",
  },
  {
    question: "Is FastTrax better than outdoor go-kart tracks?",
    answer:
      "FastTrax is Florida's largest indoor karting destination with climate-controlled racing year-round — rain or shine. Unlike outdoor gas-powered karts, our EcoVolt GT electric karts deliver instant torque with zero emissions, F1-style digital displays, and push-to-pass boost systems on a multi-level track with elevation changes.",
  },
  {
    question: "What should I wear to go-kart racing?",
    answer:
      "Closed-toe shoes are required — no exceptions. Comfortable clothing that allows free movement is recommended. Helmets and safety gear are provided with your Racing License. Remove all loose items from pockets (lockers are provided).",
  },
  {
    question: "Does FastTrax have food and drinks?",
    answer:
      "Yes! Nemo's Trackside is FastTrax's full-service trackside restaurant featuring authentic wood-fired brick oven pizza, craft cocktails, beer, and a full menu. Watch live racing from your table.",
  },
  {
    question: "How does FastTrax compare to Dave & Buster's or Topgolf?",
    answer:
      "FastTrax offers a unique combination that neither can match: high-performance indoor go-kart racing on a multi-level track, plus arcade, duckpin bowling, shuffleboard, and a full-service restaurant. Unlike Dave & Buster's, we have go-karts. Unlike Topgolf, we're fully indoor and offer way more variety of activities for all ages.",
  },
  {
    question: "Is FastTrax part of HeadPinz?",
    answer:
      "FastTrax and HeadPinz are connected buildings on the same campus at 14501 Global Parkway in Fort Myers. FastTrax is the 63,000 sq ft racing and entertainment hub (go-karts, arcade, duckpin bowling, shuffleboard, and Nemo's Trackside). HeadPinz is the 53,000 sq ft social entertainment flagship (traditional bowling, laser tag, gel blasters, and more). Together they form a 116,000 sq ft entertainment destination — the largest in Southwest Florida.",
  },
  {
    question: "Where is FastTrax located in Fort Myers?",
    answer:
      "FastTrax is located at 14501 Global Parkway, Fort Myers, FL 33913 — near Gulf Coast Town Center and I-75. Free parking is available on-site. The venue is easy to find and accessible from Cape Coral, Estero, Bonita Springs, Naples, and all of Southwest Florida.",
  },
  {
    question: "Can toddlers and small kids race at FastTrax?",
    answer:
      "Yes! FastTrax has Mini Karts specifically designed for children ages 4-6. There's no minimum height requirement for Mini Karts. They feature adjustable pedals and seats, speed-controlled settings, and close at 10:00 PM daily. Mini Karts are available on Mega Track Tuesdays too.",
  },
  {
    question: "What are the best things to do in Fort Myers when it rains?",
    answer:
      "FastTrax is Fort Myers' top rainy day activity — 63,000 sq ft of fully indoor, climate-controlled entertainment including go-kart racing on multi-level tracks, 50+ arcade games, duckpin bowling, shuffleboard, and Nemo's Trackside. No weather worries. Open Mon-Thu 3-11 PM, Fri 3 PM-12 AM, Sat 11 AM-12 AM, Sun 11 AM-11 PM.",
  },
  {
    question: "Does FastTrax have birthday party packages?",
    answer:
      "Yes! FastTrax hosts birthday parties for all ages with private racing heats, dedicated event coordinators, VIP viewing areas, and catering by Nemo's Trackside. Groups of 14 to 1,000+ guests. Visit our Group Events page or call to start planning your party.",
  },
  {
    question: "What is duckpin bowling at FastTrax?",
    answer:
      "Duckpin bowling is a fast-paced, social style of bowling using smaller balls (no finger holes) and shorter pins. No rental shoes required — bowl in your own clean, closed-toe shoes. Lanes are $35/hour at FastTrax. It's perfect for groups, date nights, and families.",
  },
  {
    question: "Is FastTrax good for a date night in Fort Myers?",
    answer:
      "FastTrax is one of the best date night spots in Fort Myers. Race go-karts together, grab craft cocktails and brick oven pizza at Nemo's Trackside with trackside views, play arcade games, or try duckpin bowling. Way more exciting than dinner and a movie.",
  },
  {
    question: "Does FastTrax do corporate team building events?",
    answer:
      "Yes — FastTrax is Fort Myers' premier corporate event venue. We offer private racing heats, team competitions with live timing, VIP lounge access, dedicated meeting rooms, catering packages by Nemo's Trackside, and dedicated event coordinators for groups of 14 to 1,000+. More engaging than Topgolf corporate events and more variety than Dave & Buster's.",
  },
  {
    question: "What is the FastTrax Racing App?",
    answer:
      "The FastTrax Racing App (powered by BMI Leisure) lets you book races, view live timing and leaderboards, track your ProSkill ranking, access your full race history, and use express QR code check-in. Download it free on the App Store or Google Play.",
  },
  {
    question: "Can you spend a whole day at FastTrax and HeadPinz?",
    answer:
      "Absolutely — FastTrax and HeadPinz together are a full-day destination. With 116,000 sq ft across two connected buildings, you can race go-karts, hit the arcade, bowl duckpin or traditional, play laser tag, battle it out with gel blasters, try shuffleboard, eat brick oven pizza at Nemo's Trackside. Most families and groups easily spend 3-5+ hours. It's the ultimate day out in Fort Myers.",
  },
  {
    question: "Are electric go-karts better than gas go-karts?",
    answer:
      "Electric karts like FastTrax's EcoVolt GT deliver instant torque (no lag), zero emissions (no fumes indoors), quieter operation, and more consistent performance. They also feature push-to-pass boost systems and F1-style digital steering displays — technology you won't find on gas karts at outdoor tracks like Gator Mike's.",
  },
];

export default function RacingLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <FAQJsonLd faqs={racingFaqs} />
      {children}
    </>
  );
}
