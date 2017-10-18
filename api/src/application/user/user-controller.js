const querystring = require('querystring');
const formatError = require('../../lib/format-error');
const get = require('lodash/get');
const set = require('lodash/set');
const uuid = require('uuid');
const config = require('../../../config');
const Boom = require('boom');
const views = require('./user-views');
const errorMessages = require('./user-error-messages');
const userFormData = require('./user-form-data');
const comparePasswords = require('../../lib/comparePasswords');

// e.g. convert { foo.bar: 'baz' } to { foo: { bar: 'baz' }}
const expandDotPaths = function(object) {
  Object.keys(object).forEach(key => {
    if (key.indexOf('.') > -1) {
      const value = object[key];
      delete(object[key]);
      set(object, key, value);
    }
  });
  return object;
};

module.exports = (
  userService,
  emailService,
  imageService,
  themeService,
  validationError,
  clientService
) => {
  return {
    register: async function(request, reply, user, client, render) {
      let error;
      try {
        const user = await userService.create(request.payload.email, request.payload.password)
        reply.redirect(`/op/auth?${querystring.stringify(request.query)}`);
      } catch (e) {
        // assume email collision and show validation message
        error = { email: ['That email address is already in use'] }
        await render(error);
      }
    },

    changePassword: async function(request, reply, user, client, render) {
      const { current, password } = request.payload;
      const isAuthenticated = await comparePasswords(current, user);
      let error;

      if (isAuthenticated) {
        const hashedPassword = await userService.encryptPassword(password);
        await userService.update(user.get('id'), { password: hashedPassword });
        await userService.sendPasswordChangeEmail(user.get('email'), client);
      } else {
        error = { current: ['Password is incorrect'] };
      }
      await render(error);
    },

    updateProfile: async function(request, reply, user, client) {
      let profile = user.get('profile');
      const payload = expandDotPaths(request.payload);

      const oldPicture = profile.picture;
      const pictureMIME = request.payload.picture.hapi.headers['content-type'];

      if (pictureMIME === 'image/jpeg' || pictureMIME === 'image/png') {
        const uuid = uuid();
        const bucket = uuid.substring(0, 2);
        const filename = await imageService.uploadImageStream(request.payload.picture, `pictures/${bucket}/${filename}`);

        profile = Object.assign(profile, payload, { picture: filename });
      } else {
        delete request.payload.picture;
        profile = Object.assign(profile, payload);
      }

      await userService.update(user.get('id'), { profile });

      if (oldPicture) {
        await imageService.deleteImage(oldPicture.replace(/^.*\/\/[^\/]+\//, ''));
      }

      reply.redirect(request.query.redirect_uri)
    },

    getForgotPasswordForm: async function(request, reply, source, error) {
      const viewContext = views.forgotPassword(request, error);
      const template = await themeService.renderThemedTemplate(request.query.client_id, 'forgot-password', viewContext);
      if (template) {
        reply(template);
      } else {
        reply.view('forgot-password', viewContext);
      }
    },

    postForgotPasswordForm: async function(request, reply) {
      userService.findByEmailForOidc(request.payload.email)
        .then(user => {
          return user ? userService.createPasswordResetToken(user.accountId): null
        })
        .then(token => {
          if (token) {
            return userService.sendForgotPasswordEmail(request.payload.email, request.query, token);
          }
        })
        .then(async () => {
          const viewContext = { title: 'Forgot Password' };
          const template = await themeService.renderThemedTemplate(request.query.client_id, 'forgot-password-success', viewContext);
          if (template) {
            reply(template);
          } else {
            reply.view('forgot-password-success', viewContext);
          }
        })
        .catch(e => {
          reply(e);
        });
    },

    logout: function(request, reply, source, error) {
      const sessionId = request.state._session;

      if (!sessionId) {
        console.error('Session id cookie not present');
        throw Boom.notFound();
      }

      return userService.invalidateSession(sessionId)
        .then(() => reply.redirect(request.query.post_logout_redirect_uri))
    },

    getResetPasswordForm: title => async (request, reply, source, error) => {
      const viewContext = views.resetPassword(title, request, error);
      const template = await themeService.renderThemedTemplate(request.query.client_id, 'reset-password', viewContext);
      if (template) {
        reply(template);
      } else {
        reply.view('reset-password', viewContext);
      }
    },

    postResetPasswordForm: title => async (request, reply) => {
      const user = await userService.findByPasswordToken(request.query.token)

      if (user) {
        const password = await userService.encryptPassword(request.payload.password)
        const profile = user.get('profile');
        profile.email_verified = true;
        await userService.update(user.get('id'), { password, profile });
        await userService.destroyPasswordToken(request.query.token);

        const viewContext = views.resetPasswordSuccess(title, request);
        const template = await themeService.renderThemedTemplate(request.query.client_id, 'reset-password-success', viewContext);
        if (template) {
          reply(template);
        } else {
          reply.view('reset-password-success', viewContext);
        }
      } else {
        const viewContext = views.resetPassword(request, { token: ['Token is invalid or expired'] });
        const template = await themeService.renderThemedTemplate(request.query.client_id, 'reset-password', viewContext);

        if (template) {
          reply(template);
        } else {
          reply.view('reset-password', viewContext);
        }
      }
    }
  };
};

module.exports['@singleton'] = true;
module.exports['@require'] = [
  'user/user-service',
  'email/email-service',
  'image/image-service',
  'theme/theme-service',
  'validator/validation-error',
  'client/client-service',
];
