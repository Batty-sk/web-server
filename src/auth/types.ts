export type Audience = 'user' | 'admin';
export type ProviderName = 'apple' | 'google' | 'dev';

/** What a provider tells us about the person once their sign-in is verified. */
export interface Profile {
  provider: ProviderName;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string;
  avatarUrl: string | null;
}
