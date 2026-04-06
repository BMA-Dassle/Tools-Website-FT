import HeadPinzNav from "@/components/headpinz/Nav";
import HeadPinzFooter from "@/components/headpinz/Footer";

export default function LocationLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <HeadPinzNav />
      <div className="pt-16 lg:pt-20">{children}</div>
      <HeadPinzFooter />
    </>
  );
}
