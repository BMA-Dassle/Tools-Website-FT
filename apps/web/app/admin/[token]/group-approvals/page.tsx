import { notFound } from "next/navigation";
import GroupApprovalsClient from "./GroupApprovalsClient";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { params: Promise<{ token: string }> };

export default async function Page({ params }: Props) {
  const { token } = await params;
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) notFound();

  return <GroupApprovalsClient token={token} />;
}
