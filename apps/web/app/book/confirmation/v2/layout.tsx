import BrandNav from "@/components/BrandNav";

/**
 * HeadPinz nav for the v2 confirmation page. The root layout's FastTrax Nav is
 * gated to !isHeadPinz (showChrome), so HeadPinz visitors need BrandNav here.
 * BrandNav renders nothing on FastTrax (no double nav); the page supplies its
 * own top padding (pt-36).
 */
export default function ConfirmationV2Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <BrandNav />
      {children}
    </>
  );
}
