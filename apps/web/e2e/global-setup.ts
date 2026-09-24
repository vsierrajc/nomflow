import { resetDatabase } from './support';

export default async function globalSetup(): Promise<void> {
  await resetDatabase();
}
