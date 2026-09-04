package com.acme.core.session;

import de.hybris.platform.commerceservices.i18n.CommonI18NService;
import de.hybris.platform.core.model.c2l.LanguageModel;
import de.hybris.platform.core.model.user.UserModel;
import de.hybris.platform.servicelayer.session.SessionService;
import de.hybris.platform.servicelayer.user.UserService;

/**
 * Every call this class makes is the replacement `service-no-session` asks for. A rule that fires
 * on its own suggestion teaches a developer to ignore it, so the fix is a precision fixture.
 */
public class AcmeSessionHelper
{
    private UserService userService;
    private SessionService sessionService;
    private CommonI18NService commonI18NService;

    public void impersonate(final UserModel user)
    {
        userService.setCurrentUser(user);
    }

    public UserModel caller()
    {
        return userService.getCurrentUser();
    }

    public LanguageModel callerLanguage()
    {
        return commonI18NService.getCurrentLanguage();
    }

    public void withLocalContext(final Runnable work)
    {
        sessionService.createLocalSessionContext();
        try
        {
            work.run();
        }
        finally
        {
            sessionService.removeLocalSessionContext();
        }
    }
}
