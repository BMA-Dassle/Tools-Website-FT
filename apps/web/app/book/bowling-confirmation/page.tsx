import BowlingConfirmation from "@/components/bowling/BowlingConfirmation";

/**
 * FastTrax duckpin standalone confirmation, served on fasttraxent.com under
 * /book (not /hp) so BrandNav defers to the FastTrax site layout nav and the
 * booking's short link / confirmBase stay on the FastTrax domain. Renders the
 * SAME shared BowlingConfirmation as HeadPinz — it self-brands FastTrax from the
 * reservation's centerCode (LAB52GY480CJF). A distinct path (not /book/duck-pin)
 * so it never shadows the /book/[attraction]/v2 booking route.
 */
export default function DuckpinConfirmationPage() {
  return <BowlingConfirmation kind="open" />;
}
