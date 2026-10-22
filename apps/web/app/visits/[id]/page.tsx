export const metadata = { title: "Visit" };
import { VisitScreen } from "../../../components/visit-screen";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <VisitScreen id={id} />;
}
