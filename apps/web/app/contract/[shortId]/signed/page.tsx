import { redirect } from "next/navigation";

/**
 * /contract/{shortId}/signed — redirects back to the main contract page.
 *
 * The main ContractClient component handles all three states (sign, pay, done).
 * This route exists as a stable URL for PandaDoc post-signing redirects
 * and SMS/email celebration links. It simply bounces back to the parent
 * page which will render the appropriate state.
 */
export default async function SignedPage(props: { params: Promise<{ shortId: string }> }) {
  const { shortId } = await props.params;
  redirect(`/contract/${shortId}`);
}
