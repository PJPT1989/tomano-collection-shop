// Shared Supabase client. Loaded after the supabase-js CDN script.
// The anon key is safe to expose client-side — row level security on the
// `products` table controls what it can actually do (public read, only
// logged-in users can write).
const SUPABASE_URL = "https://jcxiktmftokritzxrrxx.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpjeGlrdG1mdG9rcml0enhycnh4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk5ODgwNDYsImV4cCI6MjEwNTU2NDA0Nn0.zF5EgmJy_6YzOD7smdpUycH_Y3jEuP4XhthI3t_sW1A";

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
