// Supabase connection for admin mode. Leave blank to run as a plain read-only site.
// Both values are public by design; security comes from the row-level policies in supabase/schema.sql.
// Never put a password in this file: it is published with the site.
window.SITE_CONFIG = {
  supabaseUrl: "",
  supabaseAnonKey: "",
  // The login form takes a username; Supabase needs an email, so "ZiggyZorb" signs in as ziggyzorb@devonmarlin.com.
  adminEmailDomain: "devonmarlin.com",
};
