// Lion Rock — Supabase connection details for the upload modal.
//
// This is the TEMPLATE (committed). Copy it to the real filename, which is
// gitignored, and paste your values in:
//
//   cp assets/js/supabase-config.example.js assets/js/supabase-config.js
//
// Values come from your Supabase dashboard:
//   Project Settings → API → Project URL, and the `anon` / public key.
//
// The anon key is safe to ship in client-side code — it is designed to be
// public. Row Level Security (see supabase/schema.sql) is what actually gates
// writes: reads are open, but uploading requires a signed-in user.
//
// Never put the `service_role` key here — it bypasses RLS completely.
window.SUPABASE_CONFIG = {
  url: 'https://YOUR-PROJECT-REF.supabase.co',
  anonKey: 'YOUR-ANON-PUBLIC-KEY',
  bucket: 'walkthrough-videos',
};
