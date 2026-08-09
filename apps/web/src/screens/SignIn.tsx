/**
 * Sign-in screen (spec §5.2 Authentication). Form skeleton only — no
 * submission wiring beyond preventDefault; username-login flows land with
 * the auth work (spec §14.1).
 */
export function SignIn() {
  return (
    <>
      <h1>Sign in</h1>
      <p>
        Sign in with the username and password provided by your league
        organizer.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <div>
          <label htmlFor="sign-in-username">Username</label>
          <input
            id="sign-in-username"
            name="username"
            type="text"
            autoComplete="username"
            required
          />
        </div>
        <div>
          <label htmlFor="sign-in-password">Password</label>
          <input
            id="sign-in-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </div>
        <button type="submit">Sign in</button>
      </form>
    </>
  );
}
