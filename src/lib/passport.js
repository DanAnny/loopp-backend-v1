import passport from "passport";
import { User } from "../models/User.js";
import { Strategy as JwtStrategy, ExtractJwt } from "passport-jwt";

// local strategy from passport-local-mongoose
passport.use(User.createStrategy());
passport.serializeUser(User.serializeUser());
passport.deserializeUser(User.deserializeUser());

// JWT strategy for API protection (access token from Authorization header)
passport.use(
  new JwtStrategy(
    {
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: process.env.JWT_ACCESS_SECRET,
    },
    async (payload, done) => {
      try {
        const user = await User.findById(payload.id).lean();
        if (!user) return done(null, false);
        return done(null, user);
      } catch (e) {
        return done(e, false);
      }
    }
  )
);

export default passport;
