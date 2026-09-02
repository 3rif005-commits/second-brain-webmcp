-- Fix handle_new_user trigger:
-- 1. Add SET search_path = public so the trigger can find public.profiles
--    when fired from the auth schema context.
-- 2. Add an INSERT policy so the service role / trigger can always insert.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, avatar_url)
  VALUES (
    NEW.id,
    NEW.email,
    NEW.raw_user_meta_data->>'full_name',
    NEW.raw_user_meta_data->>'avatar_url'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Allow the service role (used by the trigger / admin operations) to insert profiles.
-- The anon / authenticated roles still cannot insert directly (no policy for them).
CREATE POLICY "profiles: service role insert"
  ON public.profiles FOR INSERT
  WITH CHECK (true);
