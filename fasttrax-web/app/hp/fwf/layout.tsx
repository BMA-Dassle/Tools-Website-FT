import HeadPinzNav from "@/components/headpinz/Nav";
import HeadPinzFooter from "@/components/headpinz/Footer";

export default function FWFLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <HeadPinzNav />
      <div>{children}</div>
      <HeadPinzFooter />
    </>
  );
}
