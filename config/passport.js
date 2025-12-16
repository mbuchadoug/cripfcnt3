// config/passport.js
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import User from "../models/user.js";

export default function configurePassport() {
  passport.serializeUser((user, done) => {
    done(null, user._id);
  });

  passport.deserializeUser(async (id, done) => {
    try {
      const user = await User.findById(id).lean();
      done(null, user || null);
    } catch (err) {
      done(err, null);
    }
  });

  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: process.env.GOOGLE_CALLBACK_URL,
      },
      async (accessToken, refreshToken, profile, done) => {
        try {
          // Extract common fields
          const googleId = profile.id;
          const displayName = profile.displayName;
          const firstName = profile.name?.givenName || "";
          const lastName = profile.name?.familyName || "";
          const email = profile.emails?.[0]?.value?.toLowerCase() || "";
          const photo = profile.photos?.[0]?.value || "";
          const provider = profile.provider || "google";
          const locale = profile._json?.locale || "";

          // Upsert user
          const update = {
            displayName,
            firstName,
            lastName,
            email,
            photo,
            provider,
            locale,
            lastLogin: new Date(),
          };

          const opts = { upsert: true, new: true, setDefaultsOnInsert: true };

          const user = await User.findOneAndUpdate(
            { googleId },
            { $set: update, $setOnInsert: { createdAt: new Date(), googleId } },
            opts
          );

          return done(null, user);
        } catch (err) {
          return done(err, null);
        }
      }
    )
  );
}
