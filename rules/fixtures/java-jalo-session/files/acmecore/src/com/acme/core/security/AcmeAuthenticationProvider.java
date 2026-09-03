package com.acme.core.security;

import de.hybris.platform.jalo.JaloSession;
import de.hybris.platform.jalo.user.User;

public class AcmeAuthenticationProvider
{
    public void authenticate(final User user)
    {
        JaloSession.getCurrentSession().setUser(user);
    }
}
