export const metadata = { title: "Private visitor conversation" };
import { GuestScreen } from "../../../components/guest-screen";
export default async function Page({
  params,
}: {
  params: Promise<{ publicDoorId: string }>;
}) {
  const { publicDoorId } = await params;
  return <GuestScreen publicDoorId={publicDoorId} />;
}
