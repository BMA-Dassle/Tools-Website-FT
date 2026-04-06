import HeadPinzNav from "@/components/headpinz/Nav";

export default function BowlingBookLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <HeadPinzNav />
      <div>{children}</div>
    </>
  );
}
